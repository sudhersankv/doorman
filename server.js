require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'content-type'); next(); });

// Mock site the agents visit (Trailhead Outfitters)
app.use('/shop', express.static(path.join(__dirname, 'public', 'shop')));
app.use('/doorman.js', express.static(path.join(__dirname, 'public', 'doorman.js')));
app.get('/', (req, res) => res.redirect('/shop/'));
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Doorman server on http://localhost:${PORT}  (shop: /shop/)`));
