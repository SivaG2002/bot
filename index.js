// index.js
require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { Client, GatewayIntentBits, Routes, ButtonBuilder, ActionRowBuilder, ButtonStyle, Partials } = require('discord.js');
const { REST } = require('@discordjs/rest');
const session = require('express-session');
const crypto = require('crypto');

const {
  DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, CHANNEL_ID,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI,
  TARGET_CHANNEL_HANDLE, TARGET_CHANNEL_ID, SESSION_SECRET, PORT
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !GUILD_ID || !CHANNEL_ID || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !OAUTH_REDIRECT_URI) {
  console.error('Missing env vars. Check .env file.');
  process.exit(1);
}

// Basic in-memory store for demo (replace with DB in production)
const verifiedUsers = new Map(); // discordUserId -> { youtubeId, email, verifiedAt }

// Google OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  OAUTH_REDIRECT_URI
);

// Scopes: youtube.readonly needed to check subscriptions + profile email
const OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/youtube.readonly'
];

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: SESSION_SECRET || crypto.randomBytes(16).toString('hex'),
  resave: false,
  saveUninitialized: true
}));

// ---------------------------------------------
// Helper: resolve handle to channelId via YouTube API
// (uses public channels.list?forUsername or search.list as fallback)
async function resolveChannelIdFromHandle(handle) {
  // if handle begins with @, strip it
  let name = handle?.startsWith('@') ? handle.substring(1) : handle;
  if (!name) return null;

  // Use the YouTube Data API via REST (no auth required for public lookup)
  try {
    // Try channels.list with "forUsername" first (older username)
    let url1 = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(name)}&key=${GOOGLE_CLIENT_SECRET ? '': ''}`;
    // But the reliable route is search.list
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(name)}&maxResults=5&key=${process.env.GOOGLE_API_KEY || ''}`;

    // If user provided GOOGLE_API_KEY in env, we can call search.list directly:
    if (process.env.GOOGLE_API_KEY) {
      const resp = await fetch(searchUrl);
      const data = await resp.json();
      if (data && data.items && data.items.length) {
        // pick the top result
        return data.items[0].snippet.channelId;
      }
    }
  } catch (err) {
    console.warn('Could not auto-resolve channel id from handle', err.message || err);
  }
  return null;
}

// ---------------------------------------------
// OAuth start: called when user clicks the verify button
// We'll accept a "state" param which will include discordUserId so we can map back
app.get('/auth', (req, res) => {
  const { discordId } = req.query;
  if (!discordId) return res.status(400).send('Missing discordId in query');

  const state = Buffer.from(JSON.stringify({ discordId })).toString('base64');
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: OAUTH_SCOPES,
    state
  });
  res.redirect(url);
});

// OAuth callback
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  if (!code || !state) return res.status(400).send('Missing code or state');

  let parsed;
  try { parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf8')); } catch (e) {
    return res.status(400).send('Invalid state');
  }
  const { discordId } = parsed;
  if (!discordId) return res.status(400).send('Missing discordId in state');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Use YouTube API to check if the authenticated user subscribes to TARGET_CHANNEL_ID
    let channelId = TARGET_CHANNEL_ID || (await resolveChannelIdFromHandle(TARGET_CHANNEL_HANDLE));
    if (!channelId) return res.status(500).send('Target channel ID not set and auto-resolve failed. Put TARGET_CHANNEL_ID in .env');

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    // Query subscriptions where mine=true and forChannelId=channelId
    const subsResp = await youtube.subscriptions.list({
      part: 'id,snippet',
      mine: true,
      forChannelId: channelId,
      maxResults: 1
    });

    const isSubscribed = (subsResp.data.items && subsResp.data.items.length > 0);

    // Get basic user info (email, sub)
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const userinfo = await oauth2.userinfo.get();
    const youtubeId = userinfo.data.id || tokens.id_token || 'unknown';

    // Save verification state (in-memory store)
    verifiedUsers.set(discordId, {
      youtubeId,
      email: userinfo.data.email,
      verifiedAt: new Date().toISOString(),
      subscribed: isSubscribed
    });

    // Optionally you can notify the Discord bot to update a message — we will just show a friendly page and direct user to return to Discord
    const returnHtml = `
      <h2>Verification ${isSubscribed ? 'success' : 'failed'}</h2>
      <p>${isSubscribed ? 'You are subscribed — go back to Discord to see the ✅.' : 'You are not subscribed to the channel.'}</p>
      <p>You can close this window.</p>
    `;
    res.send(returnHtml);
  } catch (err) {
    console.error('OAuth callback error', err);
    res.status(500).send('OAuth error: ' + (err.message || err));
  }
});

// Endpoint for bot to check verifiedUsers map (bot polls this or uses webhook)
// For simplicity, expose read-only route to check a discordId
app.get('/check/:discordId', (req, res) => {
  const info = verifiedUsers.get(req.params.discordId);
  if (!info) return res.json({ verified: false });
  return res.json({ verified: true, info });
});

// ---------------------------------------------
// Discord bot part
const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ],
  partials: [ Partials.Channel ]
});

client.once('ready', async () => {
  console.log('Discord bot ready:', client.user.tag);

  // Post a verification message with a button in CHANNEL_ID
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) throw new Error('Channel not found');

    // create a button that users press to verify
    const verifyButton = new ButtonBuilder()
      .setCustomId('verify_sub_button')
      .setLabel('Verify Subscribe')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(verifyButton);

    // Send a new message (you can keep the messageId if you want to reuse)
    await channel.send({
      content: `Click the button below to verify subscription to the channel ${TARGET_CHANNEL_HANDLE || TARGET_CHANNEL_ID}`,
      components: [row]
    });
    console.log('Posted verification message in channel', CHANNEL_ID);
  } catch (err) {
    console.error('Error posting verification message:', err);
  }
});

client.on('interactionCreate', async interaction => {
  if (interaction.isButton()) {
    if (interaction.customId === 'verify_sub_button') {
      // Build an OAuth link with discordId in state
      const discordId = interaction.user.id;
      const authUrl = `/auth?discordId=${encodeURIComponent(discordId)}`;
      const fullUrl = `${getServerBaseUrl()}${authUrl}`;

      // reply ephemerally with a link so only the clicking user sees it
      await interaction.reply({
        content: `Click here to sign in with Google and verify: ${fullUrl}`,
        ephemeral: true
      });

      // optional: start a small poll loop to check when the user finishes auth and update a server message
      (async () => {
        // poll for up to 45 seconds for verification result
        for (let i=0;i<9;i++) {
          await new Promise(r => setTimeout(r, 5000));
          const resp = await fetch(`${getServerBaseUrl()}/check/${discordId}`);
          const obj = await resp.json();
          if (obj.verified) {
            // notify the user or update a channel message — we'll DM them
            try {
              const dm = await interaction.user.createDM();
              await dm.send(`Verification result: ${obj.info.subscribed ? 'Subscribed ✅' : 'Not subscribed ❌'}`);
            } catch (e) { console.warn('Could not DM user', e.message); }
            return;
          }
        }
      })();
    }
  }
});

// Helper: determine server base url for OAuth redirection & links. In dev it's localhost:3000
function getServerBaseUrl() {
  const port = process.env.PORT || PORT || 3000;
  // For local testing:
  if (process.env.NODE_ENV !== 'production') return `http://localhost:${port}`;
  // Replace with your production HTTPS domain if deployed
  return process.env.PUBLIC_BASE_URL || `https://yourdomain.example`;
}

client.login(DISCORD_TOKEN);

// Start express server
app.listen(serverPort, () => {
  console.log(`Express server listening on ${serverPort}`);

  // Show possible Railway URLs
  console.log("🔗 Railway Domain Info:");
  console.log("RAILWAY_STATIC_URL =", process.env.RAILWAY_STATIC_URL);
  console.log("RAILWAY_PUBLIC_DOMAIN =", process.env.RAILWAY_PUBLIC_DOMAIN);
  console.log("PUBLIC_BASE_URL =", process.env.PUBLIC_BASE_URL);

  // Auto-generate full base URL
  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.RAILWAY_STATIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null);

  if (base) {
    console.log("🌍 Public Base URL:", base);
    console.log("➡ OAuth Callback URL:", `${base}/oauth2callback`);
    console.log("➡ Auth Start URL:", `${base}/auth?discordId=YOUR_ID`);
  } else {
    console.log("❗ No Railway URL detected yet.");
  }
});

