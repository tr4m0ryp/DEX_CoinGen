// server.js

// Importeer benodigde modules
const express = require('express');
const bodyParser = require('body-parser');
const multer  = require('multer');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode'); // Voor QR-code generatie
const {
  Connection,
  clusterApiUrl,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} = require('@solana/web3.js');

// Importeer de functies van @solana/spl-token als named exports
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

// Importeer de functie voor het maken van de metadata account
const { createCreateMetadataAccountV2Instruction } = require('@metaplex-foundation/mpl-token-metadata');

// Definieer handmatig de Metaplex Token Metadata Program ID
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Initialiseer de Express-applicatie
const app = express();
const port = process.env.PORT || 3000;

// Configureer Multer voor logo uploads (bestanden worden opgeslagen in de map "uploads")
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Unieke bestandsnaam gebaseerd op datum en originele naam
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Middleware voor statische bestanden en body-parser
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// POST-route voor tokencreatie
app.post('/create-token', upload.single('logo'), async (req, res) => {
  try {
    const {
      network,       // 'devnet' of 'mainnet-beta'
      tokenName,
      tokenSymbol,
      metadataUri,
      totalSupply,
      decimals,
      socials,
      userWallet    // Jouw walletadres (waar 70% van de tokens naartoe gaan)
    } = req.body;

    // Maak verbinding met het gekozen Solana-netwerk
    const connection = new Connection(clusterApiUrl(network));
    console.log("Using network:", network);

    // Genereer een nieuwe wallet (die als payer fungeert)
    const payer = Keypair.generate();
    console.log("Generated wallet address:", payer.publicKey.toBase58());

    // Afhankelijk van het netwerk:
    if (network === 'devnet') {
      // Vraag een airdrop aan van 0.1 SOL op devnet
      const airdropSignature = await connection.requestAirdrop(payer.publicKey, 0.1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSignature);
      console.log("Airdrop successful on devnet.");
      // Op devnet mag je de walletgegevens gerust tonen (voor testdoeleinden)
    } else if (network === 'mainnet-beta') {
      // Voor mainnet-beta: controleer of er voldoende saldo is
      const balance = await connection.getBalance(payer.publicKey);
      console.log("Mainnet wallet balance:", balance);
      if (balance < 0.1 * LAMPORTS_PER_SOL) {
        // Als onvoldoende saldo, genereer dan een QR-code met wallet-gegevens zodat de gebruiker kan storten
        const walletDetails = `Address: ${payer.publicKey.toBase58()}\nSecret: ${Buffer.from(payer.secretKey).toString('hex')}`;
        const qrCodeDataUrl = await QRCode.toDataURL(walletDetails);
        return res.send(`
          <h1>Wallet Aangemaakt (Mainnet-beta)</h1>
          <p>De volgende wallet is aangemaakt. Stort voldoende SOL op dit adres om door te gaan:</p>
          <p><strong>Wallet Address:</strong> ${payer.publicKey.toBase58()}</p>
          <p><strong>Secret Key (Hex):</strong> ${Buffer.from(payer.secretKey).toString('hex')}</p>
          <img src="${qrCodeDataUrl}" alt="QR Code met wallet details"/>
          <p>Na het storten, herlaad deze pagina of verstuur het formulier opnieuw om het token creatieproces voort te zetten.</p>
          <a href="/">Ga terug</a>
        `);
      }
    }

    // Genereer een deposit wallet (bijvoorbeeld voor toekomstige SOL-transacties)
    const depositWallet = Keypair.generate();
    console.log("Gegenereerde Deposit Address:", depositWallet.publicKey.toBase58());

    // Maak de token mint aan
    console.log("Creëer token mint...");
    const mint = await createMint(
      connection,
      payer,
      payer.publicKey, // mint authority
      null,            // freeze authority (optioneel)
      parseInt(decimals)
    );
    console.log("Token Mint Address:", mint.toBase58());

    // Verdeel de token supply: 70% naar de door de gebruiker opgegeven wallet en 30% naar een nieuw gegenereerd wallet
    const totalSupplyBig = BigInt(totalSupply);
    const userShare = totalSupplyBig * 70n / 100n;
    const otherShare = totalSupplyBig - userShare;

    // Maak een token account aan voor het door de gebruiker opgegeven walletadres (70% tokens)
    const userTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      new PublicKey(userWallet)
    );

    // Genereer een nieuw wallet (en token account) voor de overige 30%
    const generatedWallet = Keypair.generate();
    const generatedTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      generatedWallet.publicKey
    );

    // Mint 70% tokens naar de door de gebruiker opgegeven wallet
    console.log("Mint 70% van de tokens naar jouw wallet...");
    await mintTo(
      connection,
      payer,
      mint,
      userTokenAccount.address,
      payer.publicKey,
      userShare
    );

    // Mint 30% tokens naar het nieuw gegenereerde wallet
    console.log("Mint 30% van de tokens naar het gegenereerde wallet...");
    await mintTo(
      connection,
      payer,
      mint,
      generatedTokenAccount.address,
      payer.publicKey,
      otherShare
    );

    // Verwerk het geüploade logo (indien aanwezig)
    let logoUrl = "";
    if (req.file) {
      logoUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      console.log("Logo geüpload naar:", logoUrl);
    }

    // Probeer de extra socials te parsen (als JSON)
    let socialsObj = null;
    if (socials) {
      try {
        socialsObj = JSON.parse(socials);
      } catch (err) {
        console.warn("Kon socials niet parsen als JSON. Controleer de input.");
      }
    }

    // Bouw het metadata object. Het externe metadata bestand (via metadataUri) bevat extra gegevens.
    const metadataData = {
      name: tokenName,
      symbol: tokenSymbol,
      uri: metadataUri,
      sellerFeeBasisPoints: 0,
      creators: null,
    };

    // Voeg metadata toe via het Metaplex Token Metadata programma
    console.log("Voeg metadata toe...");
    const metadataSeeds = [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ];
    const [metadataPDA] = await PublicKey.findProgramAddress(metadataSeeds, TOKEN_METADATA_PROGRAM_ID);

    const metadataIx = createCreateMetadataAccountV2Instruction(
      {
        metadata: metadataPDA,
        mint: mint,
        mintAuthority: payer.publicKey,
        payer: payer.publicKey,
        updateAuthority: payer.publicKey,
      },
      {
        createMetadataAccountArgsV2: {
          data: metadataData,
          isMutable: true,
        },
      }
    );

    const transaction = new Transaction().add(metadataIx);
    const txId = await sendAndConfirmTransaction(connection, transaction, [payer]);

    // Bouw een overzichtspagina met de resultaten
    res.send(`
      <h1>Token Creëren Gelukt!</h1>
      <p><strong>Token Mint:</strong> ${mint.toBase58()}</p>
      <p><strong>Jouw Token Account (70%):</strong> ${userTokenAccount.address.toBase58()}</p>
      <p><strong>Gegenereerd Wallet (30%):</strong> ${generatedTokenAccount.address.toBase58()}</p>
      <p><strong>Deposit Address:</strong> ${depositWallet.publicKey.toBase58()}</p>
      <p><strong>Metadata PDA:</strong> ${metadataPDA.toBase58()}</p>
      <p><strong>Metadata Transactie ID:</strong> ${txId}</p>
      ${logoUrl ? `<p><strong>Logo URL:</strong> <a href="${logoUrl}" target="_blank">${logoUrl}</a></p>` : ''}
      <p>Bewaar deze gegevens zorgvuldig!</p>
      <a href="/">Ga terug</a>
    `);
  } catch (error) {
    console.error("Fout tijdens tokencreatie:", error);
    res.status(500).send(`
      <h1>Er is een fout opgetreden</h1>
      <p>${error.message}</p>
      <a href="/">Ga terug</a>
    `);
  }
});

// Start de server
app.listen(port, () => {
  console.log(`Server draait op http://localhost:${port}`);
});
