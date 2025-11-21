// index.js
require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const {
  Client,
  GatewayIntentBits,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  Partials
} = require('discord.js');
const session = require('express-session');
const crypto = require('crypto');

const {
  DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID, CHANNEL_ID,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_REDIRECT_URI,
  TARGET_CHANNEL_HANDLE, TARGET_CHANNEL_ID, SESSION_SECRET, PORT
} = process.env;

// quick env check
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !GUILD_ID || !CHANNEL_ID || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !OAUTH_REDIRECT_URI) {
  console.error('Missing env vars. Check .env file.');
  process.exit(1);
}

// Basic in-memory store for demo (replace with DB in production)
const verifiedUsers = new Map(); // discordUserId -> { youtubeId, email, verifiedAt, subscribed }

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
async function resolveChannelIdFromHandle(handle) {
  let name = handle?.startsWith('@') ? handle.substring(1) : handle;
  if (!name) return null;

  try {
    // Prefer an API key if available (faster and doesn't require OAuth)
    if (process.env.GOOGLE_API_KEY) {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(name)}&maxResults=1&key=${process.env.GOOGLE_API_KEY}`;
      const resp = await fetch(searchUrl);
      const data = await resp.json();
      if (data && data.items && data.items.length) {
        return data.items[0].snippet.channelId;
      }
    }

    // Fallback: try channels.list (may not work for handles)
    const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forUsername=${encodeURIComponent(name)}&key=${process.env.GOOGLE_API_KEY || ''}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j && j.items && j.items.length) return j.items[0].id;
  } catch (err) {
    console.warn('Could not auto-resolve channel id from handle', err?.message || err);
  }
  return null;
}

// ---------------------------------------------
// OAuth start: called when user clicks the verify button
// "discordId" is passed in query so we can map back
app.get('/auth', (req, res) => {
  const { discordId } = req.query;
  if (!discordId) return res.status(400).send('Missing discordId in query');

  // create a fresh OAuth2 client to generate URL (safe)
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    OAUTH_REDIRECT_URI
  );

  const state = Buffer.from(JSON.stringify({ discordId })).toString('base64');
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: OAUTH_SCOPES,
    state
  });
  return res.redirect(url);
});

// OAuth callback
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;
  if (!code || !state) return res.status(400).send('Missing code or state');

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
  } catch (e) {
    return res.status(400).send('Invalid state');
  }
  const { discordId } = parsed;
  if (!discordId) return res.status(400).send('Missing discordId in state');

  try {
    // Create a fresh OAuth client per request to avoid shared credentials
    const userOauthClient = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      OAUTH_REDIRECT_URI
    );

    const { tokens } = await userOauthClient.getToken(code);
    userOauthClient.setCredentials(tokens);

    const channelId = TARGET_CHANNEL_ID || (await resolveChannelIdFromHandle(TARGET_CHANNEL_HANDLE));
    if (!channelId) return res.status(500).send('Target channel ID not set and auto-resolve failed. Put TARGET_CHANNEL_ID in .env or set GOOGLE_API_KEY');

    const youtube = google.youtube({ version: 'v3', auth: userOauthClient });

    // Query subscriptions where mine=true and forChannelId=channelId
    const subsResp = await youtube.subscriptions.list({
      part: 'id,snippet',
      mine: true,
      forChannelId: channelId,
      maxResults: 1
    });

    const isSubscribed = (subsResp.data.items && subsResp.data.items.length > 0);

    // Get basic user info (email, id)
    const oauth2 = google.oauth2({ auth: userOauthClient, version: 'v2' });
    const userinfo = await oauth2.userinfo.get();
    const youtubeId = userinfo.data.id || (tokens.id_token ? 'id_from_token' : 'unknown');

    // Save verification state (in-memory store)
    verifiedUsers.set(discordId, {
      youtubeId,
      email: userinfo.data.email,
      verifiedAt: new Date().toISOString(),
      subscribed: isSubscribed
    });

    // Friendly response after verification
    const returnHtml = `
      <h2>Verification ${isSubscribed ? 'success' : 'failed'}</h2>
      <p>${isSubscribed ? 'You are subscribed — go back to Discord to see the ✅.' : 'You are not subscribed to the channel.'}</p>
      <p>You can close this window.</p>
    `;
    return res.send(returnHtml);
  } catch (err) {
    console.error('OAuth callback error', err);
    return res.status(500).send('OAuth error: ' + (err.message || err));
  }
});

// Endpoint for bot to check verifiedUsers map (bot polls this)
app.get('/check/:discordId', (req, res) => {
  const info = verifiedUsers.get(req.params.discordId);
  if (!info) return res.json({ verified: false });
  return res.json({ verified: true, info });
});

// ---------------------------------------------
// Discord bot part
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// Post a verification message when the client is ready
client.once('ready', async () => {
  console.log('Discord bot ready:', client.user.tag);

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) throw new Error('Channel not found or bot lacks access');

    const verifyButton = new ButtonBuilder()
      .setCustomId('verify_sub_button')
      .setLabel('Verify Subscribe')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(verifyButton);

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
  try {
    if (interaction.isButton() && interaction.customId === 'verify_sub_button') {
      const discordId = interaction.user.id;
      const authUrl = `/auth?discordId=${encodeURIComponent(discordId)}`;
      const fullUrl = `${getServerBaseUrl()}${authUrl}`;

      await interaction.reply({
        content: `Click here to sign in with Google and verify: ${fullUrl}`,
        ephemeral: true
      });

      // Poll for verification result for a short time and DM user
      (async () => {
        for (let i = 0; i < 12; i++) { // 12 * 5s = 60s
          await new Promise(r => setTimeout(r, 5000));
          try {
            const resp = await fetch(`${getServerBaseUrl()}/check/${discordId}`);
            const obj = await resp.json();
            if (obj.verified) {
              try {
                const dm = await interaction.user.createDM();
                await dm.send(`Verification result: ${obj.info.subscribed ? 'Subscribed ✅' : 'Not subscribed ❌'}`);
              } catch (e) {
                console.warn('Could not DM user', e.message);
              }
              return;
            }
          } catch (e) {
            // ignore transient fetch errors
          }
        }
        // timed out
        try {
          await interaction.user.createDM().then(dm => dm.send('Verification timed out. Try again.'));
        } catch (e) { /* ignore */ }
      })();
    }
  } catch (err) {
    console.error('interaction handler error', err);
  }
});

// Helper: determine server base url for OAuth redirection & links.
function getServerBaseUrl() {
  // Priority:
  // 1) PUBLIC_BASE_URL (explicit)
  // 2) RAILWAY_STATIC_URL
  // 3) RAILWAY_PUBLIC_DOMAIN
  // 4) fallback to localhost (development)
  const explicit = process.env.PUBLIC_BASE_URL;
  const railwayStatic = process.env.RAILWAY_STATIC_URL;
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const port = process.env.PORT || PORT || 3000;

  if (explicit) return explicit.replace(/\/$/, '');
  if (railwayStatic) return railwayStatic.replace(/\/$/, '');
  if (railwayDomain) return `https://${railwayDomain.replace(/\/$/, '')}`;
  return `http://localhost:${port}`;
}

client.login(DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed', err);
  process.exit(1);
});

// Start express server (ensure serverPort variable exists)
const serverPort = process.env.PORT || PORT || 3000;

app.listen(serverPort, () => {
  console.log(`Express server listening on ${serverPort}`);

  // Print Railway/public info for quick copy
  console.log("🔗 Railway / Public Domain Info:");
  console.log("PUBLIC_BASE_URL =", process.env.PUBLIC_BASE_URL);
  console.log("RAILWAY_STATIC_URL =", process.env.RAILWAY_STATIC_URL);
  console.log("RAILWAY_PUBLIC_DOMAIN =", process.env.RAILWAY_PUBLIC_DOMAIN);

  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.RAILWAY_STATIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${serverPort}`);

  if (base) {
    console.log("🌍 Public Base URL:", base);
    console.log("➡ OAuth Callback URL:", `${base.replace(/\/$/, '')}/oauth2callback`);
    console.log("➡ Auth Start URL:", `${base.replace(/\/$/, '')}/auth?discordId=YOUR_ID`);
  } else {
    console.log("❗ No public base URL detected.");
  }
});
