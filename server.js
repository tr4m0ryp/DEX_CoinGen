const express = require('express');
const bodyParser = require('body-parser');
const multer  = require('multer');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
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

const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

const { createCreateMetadataAccountV2Instruction } = require('@metaplex-foundation/mpl-token-metadata');

const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const app = express();
const port = process.env.PORT || 3000;

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------------------
// Helper: Process Token Creation
// -------------------------------
async function processTokenCreation(connection, payer, formData, req, res) {
  const { tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet } = formData;
  
  const depositWallet = Keypair.generate();
  console.log("Gegenereerde Deposit Address:", depositWallet.publicKey.toBase58());
  
  console.log("Creëer token mint...");
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,         
    parseInt(decimals)
  );
  console.log("Token Mint Address:", mint.toBase58());
  
  const totalSupplyBig = BigInt(totalSupply);
  const userShare = totalSupplyBig * 70n / 100n;
  const reserveShare = totalSupplyBig - userShare;
  
  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    new PublicKey(userWallet)
  );
  
  const generatedWallet = Keypair.generate();
  const generatedTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    generatedWallet.publicKey
  );
  
  console.log("Mint 70% tokens naar jouw wallet...");
  await mintTo(
    connection,
    payer,
    mint,
    userTokenAccount.address,
    payer.publicKey,
    userShare
  );
  
  console.log("Mint 30% tokens naar de gereserveerde wallet...");
  await mintTo(
    connection,
    payer,
    mint,
    generatedTokenAccount.address,
    payer.publicKey,
    reserveShare
  );
  
  let logoUrl = "";
  if (req.file) {
    logoUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    console.log("Logo geüpload naar:", logoUrl);
  }
  
  let socialsObj = null;
  if (socials) {
    try {
      socialsObj = JSON.parse(socials);
    } catch (err) {
      console.warn("Kon socials niet parsen als JSON.");
    }
  }
  
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
  
  res.send(`
    <h1>Token Creëren Gelukt!</h1>
    <p><strong>Token Mint:</strong> ${mint.toBase58()}</p>
    <p><strong>Jouw Token Account (70%):</strong> ${userTokenAccount.address.toBase58()}</p>
    <p><strong>Gereseveerde Wallet (30% voor liquiditeit):</strong> ${generatedTokenAccount.address.toBase58()}</p>
    <p><strong>Deposit Address:</strong> ${depositWallet.publicKey.toBase58()}</p>
    <p><strong>Metadata PDA:</strong> ${metadataPDA.toBase58()}</p>
    <p><strong>Metadata Transactie ID:</strong> ${txId}</p>
    ${logoUrl ? `<p><strong>Logo URL:</strong> <a href="${logoUrl}" target="_blank">${logoUrl}</a></p>` : ''}
    <p>Bewaar deze gegevens zorgvuldig!</p>
    <p>Om de overige 30% beschikbaar te maken voor trading op DEX’s, voeg je liquiditeit toe via het volgende formulier:</p>
    <form method="POST" action="/create-liquidity">
      <input type="hidden" name="tokenMint" value="${mint.toBase58()}">
      <input type="hidden" name="reserveTokenAccount" value="${generatedTokenAccount.address.toBase58()}">
      <!-- Stuur ook de payerSecret mee zodat liquiditeitsacties getekend kunnen worden -->
      <input type="hidden" name="payerSecret" value="${Buffer.from(payer.secretKey).toString('hex')}">
      <label for="amountToken">Hoeveelheid tokens (van de reserve) om te gebruiken:</label>
      <input type="number" name="amountToken" id="amountToken" placeholder="Bijv. 300000000" required>
      <label for="amountSol">Hoeveelheid SOL om te koppelen:</label>
      <input type="number" step="0.000001" name="amountSol" id="amountSol" placeholder="Bijv. 0.5" required>
      <button type="submit">Voeg Liquiditeit Toe</button>
    </form>
    <a href="/">Ga terug</a>
  `);
}

// --------------------------------------
// Endpoint: Initiële Tokencreatie (/create-token)
// --------------------------------------
app.post('/create-token', upload.single('logo'), async (req, res) => {
  try {
    const { network, tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet } = req.body;
    const formData = { network, tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet };
    
    const connection = new Connection(clusterApiUrl(network));
    console.log("Using network:", network);
    
    const payer = Keypair.generate();
    console.log("Generated wallet address:", payer.publicKey.toBase58());
    
    if (network === 'devnet') {
      const airdropSignature = await connection.requestAirdrop(payer.publicKey, 0.1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(airdropSignature);
      console.log("Airdrop successful on devnet.");
      await processTokenCreation(connection, payer, formData, req, res);
    } else if (network === 'mainnet-beta') {
      const balance = await connection.getBalance(payer.publicKey);
      console.log("Mainnet wallet balance:", balance);
      if (balance < 0.1 * LAMPORTS_PER_SOL) {
        const walletDetails = `Address: ${payer.publicKey.toBase58()}\nSecret: ${Buffer.from(payer.secretKey).toString('hex')}`;
        const qrCodeDataUrl = await QRCode.toDataURL(walletDetails);
        return res.send(`
          <h1>Wallet Aangemaakt (Mainnet-beta)</h1>
          <p>De volgende wallet is aangemaakt. Stort voldoende SOL op dit adres om door te gaan:</p>
          <p><strong>Wallet Address:</strong> ${payer.publicKey.toBase58()}</p>
          <p><strong>Secret Key (Hex):</strong> ${Buffer.from(payer.secretKey).toString('hex')}</p>
          <img src="${qrCodeDataUrl}" alt="QR Code met wallet details"/>
          <form method="POST" action="/continue-token" enctype="multipart/form-data">
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

// --------------------------------------
// Endpoint: Doorgaan na storten (/continue-token)
// --------------------------------------
app.post('/continue-token', upload.single('logo'), async (req, res) => {
  try {
    const { network, tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet, payerSecret } = req.body;
    const formData = { network, tokenName, tokenSymbol, metadataUri, totalSupply, decimals, socials, userWallet };
    
    const connection = new Connection(clusterApiUrl(network));
    const secretKeyArray = Uint8Array.from(Buffer.from(payerSecret, 'hex'));
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

// --------------------------------------
// Endpoint: Liquiditeitspool vormen (/create-liquidity)
// --------------------------------------
app.post('/create-liquidity', async (req, res) => {
  try {
    const { tokenMint, amountToken, amountSol, payerSecret, network } = req.body;
    
    const secretKeyArray = Uint8Array.from(Buffer.from(payerSecret, 'hex'));
    const payer = Keypair.fromSecretKey(secretKeyArray);
    const connection = new Connection(clusterApiUrl(network));
    
    const { addLiquidity } = require('./liquidityPool');
    await addLiquidity(payer, tokenMint, amountToken, amountSol);
    
    res.send(`
      <h1>Liquiditeit Toegevoegd</h1>
      <p>Er is liquiditeit toegevoegd aan de pool voor jouw token.</p>
      <a href="/">Ga terug</a>
    `);
  } catch (error) {
    console.error("Fout bij het creëren van de liquiditeitspool:", error);
    res.status(500).send(`Er is een fout opgetreden: ${error.message}`);
  }
});

app.listen(port, () => {
  console.log(`Server draait op http://localhost:${port}`);
});
