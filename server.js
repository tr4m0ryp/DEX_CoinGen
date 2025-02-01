// server.js

// Importeer benodigde modules
const express = require('express');
const bodyParser = require('body-parser');
const multer  = require('multer');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode'); // npm install qrcode
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

// Importeer functies van @solana/spl-token
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

// Initialiseer Express
const app = express();
const port = process.env.PORT || 3000;

// Configureer Multer voor logo uploads (bestanden worden in de map "uploads" opgeslagen)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Gebruik de statische map en body-parser middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// ------------------------------------
// Helper: Process Token Creation Logic
// ------------------------------------
async function processTokenCreation(connection, payer, formData, req, res) {
  const { tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet } = formData;
  
  // Genereer een deposit wallet (voor toekomstige SOL-transacties)
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
  
  // Verdeel de totale supply: 70% naar de opgegeven wallet en 30% naar een nieuw gegenereerde wallet
  const totalSupplyBig = BigInt(totalSupply);
  const userShare = totalSupplyBig * 70n / 100n;
  const otherShare = totalSupplyBig - userShare;
  
  // Maak een token account aan voor het door de gebruiker opgegeven adres (70% tokens)
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
  
  // Mint 70% tokens naar het opgegeven adres
  console.log("Mint 70% tokens naar jouw wallet...");
  await mintTo(
    connection,
    payer,
    mint,
    userTokenAccount.address,
    payer.publicKey,
    userShare
  );
  
  // Mint 30% tokens naar de nieuw gegenereerde wallet
  console.log("Mint 30% tokens naar het gegenereerde wallet...");
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
      console.warn("Kon socials niet parsen als JSON.");
    }
  }
  
  // Bouw het metadata object
  const metadataData = {
    name: tokenName,
    symbol: tokenSymbol,
    uri: metadataUri,
    sellerFeeBasisPoints: 0,
    creators: null,
  };
  
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
  
  // Toon het resultaat aan de gebruiker
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
}

// ------------------------------------
// Route: Initiële tokencreatie (/create-token)
// ------------------------------------
app.post('/create-token', upload.single('logo'), async (req, res) => {
  try {
    const { network, tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet } = req.body;
    const formData = { network, tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet };
    
    // Maak verbinding met het gekozen netwerk
    const connection = new Connection(clusterApiUrl(network));
    console.log("Using network:", network);
    
    // Genereer een nieuwe wallet (payer)
    const payer = Keypair.generate();
    console.log("Generated wallet address:", payer.publicKey.toBase58());
    
    if (network === 'devnet') {
      // Op devnet: Vraag airdrop aan en ga direct verder
      const airdropSignature = await connection.requestAirdrop(payer.publicKey, 0.1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSignature);
      console.log("Airdrop successful on devnet.");
      await processTokenCreation(connection, payer, formData, req, res);
    } else if (network === 'mainnet-beta') {
      // Op mainnet-beta: controleer saldo
      const balance = await connection.getBalance(payer.publicKey);
      console.log("Mainnet wallet balance:", balance);
      if (balance < 0.1 * LAMPORTS_PER_SOL) {
        // Onvoldoende saldo: toon pagina met walletgegevens en een "Continue"-knop.
        const walletDetails = `Address: ${payer.publicKey.toBase58()}\nSecret: ${Buffer.from(payer.secretKey).toString('hex')}`;
        const qrCodeDataUrl = await QRCode.toDataURL(walletDetails);
        return res.send(`
          <h1>Wallet Aangemaakt (Mainnet-beta)</h1>
          <p>De volgende wallet is aangemaakt. Stort voldoende SOL op dit adres om door te gaan:</p>
          <p><strong>Wallet Address:</strong> ${payer.publicKey.toBase58()}</p>
          <p><strong>Secret Key (Hex):</strong> ${Buffer.from(payer.secretKey).toString('hex')}</p>
          <img src="${qrCodeDataUrl}" alt="QR Code met wallet details"/>
          <form method="POST" action="/continue-token" enctype="multipart/form-data">
            <!-- Verberg de oorspronkelijke formuliergegevens en de payer-secret -->
            <input type="hidden" name="network" value="${network}">
            <input type="hidden" name="tokenName" value="${tokenName}">
            <input type="hidden" name="tokenSymbol" value="${tokenSymbol}">
            <input type="hidden" name="metadataUri" value="${metadataUri}">
            <input type="hidden" name="totalSupply" value="${totalSupply}">
            <input type="hidden" name="decimals" value="${decimals}">
            <input type="hidden" name="socials" value='${socials || ""}'>
            <input type="hidden" name="userWallet" value="${userWallet}">
            <input type="hidden" name="payerSecret" value="${Buffer.from(payer.secretKey).toString('hex')}">
            <button type="submit">Continue</button>
          </form>
        `);
      } else {
        // Mocht er (zelden) al voldoende saldo zijn, ga direct verder
        await processTokenCreation(connection, payer, formData, req, res);
      }
    } else {
      res.status(400).send("Ongeldig netwerk gekozen.");
    }
  } catch (error) {
    console.error("Fout tijdens tokencreatie:", error);
    res.status(500).send(`
      <h1>Er is een fout opgetreden</h1>
      <p>${error.message}</p>
      <a href="/">Ga terug</a>
    `);
  }
});

// ------------------------------------
// Route: Doorgaan na storten (/continue-token)
// ------------------------------------
app.post('/continue-token', upload.single('logo'), async (req, res) => {
  try {
    const { network, tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet, payerSecret } = req.body;
    const formData = { network, tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet };
    
    const connection = new Connection(clusterApiUrl(network));
    // Herstel de payer wallet uit de meegegeven secret (hex-string)
    const secretKeyHex = payerSecret;
    const secretKeyArray = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
    const payer = Keypair.fromSecretKey(secretKeyArray);
    console.log("Continuing with wallet:", payer.publicKey.toBase58());
    
    const balance = await connection.getBalance(payer.publicKey);
    console.log("Wallet balance on continue:", balance);
    if (balance < 0.1 * LAMPORTS_PER_SOL) {
      return res.send(`
        <h1>Saldo onvoldoende</h1>
        <p>Je hebt nog niet voldoende SOL gestort. Huidig saldo: ${balance} lamports.</p>
        <a href="/">Ga terug</a>
      `);
    }
    
    // Als het saldo nu voldoende is, ga door met tokencreatie
    await processTokenCreation(connection, payer, formData, req, res);
  } catch (error) {
    console.error("Fout tijdens tokencreatie (continue):", error);
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
