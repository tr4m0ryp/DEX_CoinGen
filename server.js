// server.js

// Importeer benodigde modules
const express = require('express');
const bodyParser = require('body-parser');
const multer  = require('multer');
const fs = require('fs');
const path = require('path');
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

// Importeer Metaplex Token Metadata functies
const {
  PROGRAM_ID: TOKEN_METADATA_PROGRAM_ID,
  createCreateMetadataAccountV2Instruction,
} = require('@metaplex-foundation/mpl-token-metadata');

// Initialiseer de Express-applicatie
const app = express();
const port = process.env.PORT || 3000;

// Maak verbinding met het Solana-netwerk (bijvoorbeeld devnet)
const connection = new Connection(clusterApiUrl("devnet"));

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
      network,
      keypairPath,   // Pad naar de keypair (als JSON-bestand)
      tokenName,
      tokenSymbol,
      metadataUri,
      totalSupply,
      decimals,
      socials,
      userWallet     // Jouw walletadres voor 70%
    } = req.body;

    // Lees de keypair uit het opgegeven bestand en maak de keypair aan
    const secretKeyString = fs.readFileSync(keypairPath, 'utf8');
    const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
    const payer = Keypair.fromSecretKey(secretKey);

    // Genereer een deposit wallet (dit adres kan gebruikt worden om SOL te ontvangen)
    const depositWallet = Keypair.generate();
    console.log("Gegenereerde Deposit Address:", depositWallet.publicKey.toBase58());

    // (Optioneel) Transfer SOL naar het deposit-adres kan hier worden toegevoegd
    /*
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: depositWallet.publicKey,
        lamports: 0.01 * LAMPORTS_PER_SOL, // bijvoorbeeld 0.01 SOL
      })
    );
    await sendAndConfirmTransaction(connection, transferTx, [payer]);
    */

    // Maak de token mint aan met de nieuwe API
    console.log("Creëer token mint...");
    const mint = await createMint(
      connection,
      payer,
      payer.publicKey, // mint authority
      null,            // freeze authority (optioneel)
      parseInt(decimals)
    );
    console.log("Token Mint Address:", mint.toBase58());

    // Verdeel de token supply in 70% en 30%
    const totalSupplyBig = BigInt(totalSupply);
    const userShare = totalSupplyBig * 70n / 100n;
    const otherShare = totalSupplyBig - userShare;

    // Maak een token account voor het opgegeven walletadres (70% tokens)
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

    // Mint 70% tokens naar de opgegeven wallet
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
      // In dit voorbeeld wordt het logo lokaal opgeslagen; in productie upload je naar een permanente opslag (zoals IPFS)
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

    // Bouw het metadata object. Het externe metadata bestand (via metadataUri) moet ook de extra velden bevatten.
    const metadataData = {
      name: tokenName,
      symbol: tokenSymbol,
      uri: metadataUri,  // Verwijzing naar een JSON-bestand met extra gegevens
      sellerFeeBasisPoints: 0,
      creators: null,
      // Extra data zoals logoUrl en socialsObj kun je eventueel hier toevoegen of in het externe JSON-bestand verwerken.
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
