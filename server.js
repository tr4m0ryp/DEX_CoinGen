// server.js

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const {
  Connection,
  clusterApiUrl,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const splToken = require('@solana/spl-token');

// Importeer Metaplex Token Metadata functies
const {
  PROGRAM_ID: TOKEN_METADATA_PROGRAM_ID,
  createCreateMetadataAccountV2Instruction,
} = require('@metaplex-foundation/mpl-token-metadata');

const app = express();
const port = process.env.PORT || 3000;

// Serveer statische bestanden vanuit de 'public' map
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// POST route voor tokencreatie
app.post('/create-token', async (req, res) => {
  const {
    network,
    keypairPath,
    tokenName,
    tokenSymbol,
    metadataUri,
    totalSupply,
    decimals,
  } = req.body;

  try {
    // Verbinding maken met het gekozen netwerk
    const connection = new Connection(clusterApiUrl(network), 'confirmed');

    // Vervang ~ door het HOME-pad
    const expandedKeypairPath = keypairPath.replace('~', process.env.HOME);
    if (!fs.existsSync(expandedKeypairPath)) {
      throw new Error(`Keypair bestand niet gevonden op: ${expandedKeypairPath}`);
    }

    // Lees en maak de keypair aan
    const secretKeyString = fs.readFileSync(expandedKeypairPath, 'utf8');
    const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
    const payer = Keypair.fromSecretKey(secretKey);

    // Maak de token mint aan
    console.log("Creëer token mint...");
    const mint = await splToken.Token.createMint(
      connection,
      payer,
      payer.publicKey, // mint authority
      null,            // freeze authority (optioneel)
      parseInt(decimals),
      splToken.TOKEN_PROGRAM_ID
    );

    // Maak de associated token account voor de eigenaar
    console.log("Creëer associated token account...");
    const ownerTokenAccount = await mint.getOrCreateAssociatedAccountInfo(payer.publicKey);

    // Mint de tokens naar het eigen account
    console.log("Mint tokens...");
    await mint.mintTo(
      ownerTokenAccount.address,
      payer.publicKey,
      [],
      BigInt(totalSupply)
    );

    // Voeg metadata toe via Metaplex Token Metadata
    console.log("Voeg metadata toe...");
    const metadataSeeds = [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.publicKey.toBuffer(),
    ];
    const [metadataPDA] = await PublicKey.findProgramAddress(metadataSeeds, TOKEN_METADATA_PROGRAM_ID);

    // Bouw het metadata object (zorg dat jouw metadata JSON bestand op de URI de vereiste data bevat)
    const metadataData = {
      name: tokenName,
      symbol: tokenSymbol,
      uri: metadataUri,
      sellerFeeBasisPoints: 0, // Geen royalty's
      creators: null,
    };

    const metadataIx = createCreateMetadataAccountV2Instruction(
      {
        metadata: metadataPDA,
        mint: mint.publicKey,
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

    // Stuur een overzicht terug aan de gebruiker
    res.send(`
      <h1>Token Creëren Gelukt!</h1>
      <p><strong>Token Mint:</strong> ${mint.publicKey.toBase58()}</p>
      <p><strong>Token Account:</strong> ${ownerTokenAccount.address.toBase58()}</p>
      <p><strong>Metadata PDA:</strong> ${metadataPDA.toBase58()}</p>
      <p><strong>Metadata Transactie ID:</strong> ${txId}</p>
      <a href="/">Ga terug</a>
    `);
  } catch (error) {
    console.error(error);
    res.send(`
      <h1>Er is een fout opgetreden</h1>
      <p>${error.message}</p>
      <a href="/">Ga terug</a>
    `);
  }
});

app.listen(port, () => {
  console.log(`Server draait op http://localhost:${port}`);
});
