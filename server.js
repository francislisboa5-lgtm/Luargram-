require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './uploads');
const MAX_RECEIPT_MB = Math.min(Math.max(Number(process.env.MAX_RECEIPT_MB || 5), 1), 10);
const PRICES = Object.freeze({ advertising_sponsorship: 500, blue_badge: 1000 });
const PAYMENT_PHONE = '944589164';

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET deve ter pelo menos 32 caracteres.');
}
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD_HASH) {
  throw new Error('Configura ADMIN_USERNAME e ADMIN_PASSWORD_HASH no ambiente.');
}
if (IS_PROD && (!process.env.APP_ORIGIN || !process.env.APP_ORIGIN.startsWith('https://'))) {
  throw new Error('Em produção, APP_ORIGIN deve ser a URL HTTPS pública do Luargram.');
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.set('trust proxy', IS_PROD ? 1 : false);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: IS_PROD ? [] : null
    }
  }
}));
app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));

const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  name: 'luargram.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 1000 * 60 * 60 * 8
  }
});
app.use(sessionMiddleware);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Espera 15 minutos e tenta novamente.' }
});
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Limite de pedidos atingido. Tenta mais tarde.' }
});

const allowedMime = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' })[file.mimetype];
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_RECEIPT_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!allowedMime.has(file.mimetype)) return cb(new Error('Formato inválido. Envia JPG, PNG, WEBP ou PDF.'));
    cb(null, true);
  }
});

function requireAdmin(req, res, next) {
  if (!req.session?.adminId) return res.status(401).json({ error: 'É necessário iniciar sessão como administrador.' });
  next();
}

// Basic same-origin protection for cookie-authenticated mutations.
function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin && process.env.APP_ORIGIN && origin !== process.env.APP_ORIGIN) {
    return res.status(403).json({ error: 'Origem não autorizada.' });
  }
  next();
}

async function ensureSchemaAndAdmin() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const existing = await pool.query('SELECT id FROM admin_users WHERE username = $1', [process.env.ADMIN_USERNAME]);
  if (existing.rowCount === 0) {
    await pool.query(
      'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
      [process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD_HASH]
    );
    console.log(`Administrador inicial criado: ${process.env.ADMIN_USERNAME}`);
  }
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'luargram-backend' }));

app.get('/api/config', (_req, res) => {
  res.json({
    prices_kz: PRICES,
    payment_method: 'Multicaixa Express',
    payment_phone: PAYMENT_PHONE,
    receipt_formats: ['JPG', 'PNG', 'WEBP', 'PDF'],
    max_receipt_mb: MAX_RECEIPT_MB
  });
});

app.post('/api/payments', requestLimiter, requireSameOrigin, (req, res, next) => {
  upload.single('receipt')(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message || 'Não foi possível receber o comprovativo.' });
    try {
      const customerName = String(req.body.customer_name || '').trim();
      const accountName = String(req.body.account_name || '').trim();
      const paymentType = String(req.body.payment_type || '').trim();
      const reference = String(req.body.transaction_reference || '').trim().slice(0, 100);
      if (customerName.length < 2 || customerName.length > 100) throw Object.assign(new Error('Indica o teu nome (2 a 100 caracteres).'), { status: 400 });
      if (accountName.length < 2 || accountName.length > 100) throw Object.assign(new Error('Indica o nome da conta ou página do Luargram.'), { status: 400 });
      if (!Object.hasOwn(PRICES, paymentType)) throw Object.assign(new Error('Escolhe um serviço válido.'), { status: 400 });
      if (!req.file) throw Object.assign(new Error('Anexa o comprovativo do pagamento.'), { status: 400 });
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO payment_requests
          (id, customer_name, account_name, payment_type, amount_kz, payment_method, payment_phone,
           transaction_reference, receipt_storage_name, receipt_original_name, receipt_mime_type)
         VALUES ($1,$2,$3,$4,$5,'multicaixa_express',$6,$7,$8,$9,$10)`,
        [id, customerName, accountName, paymentType, PRICES[paymentType], PAYMENT_PHONE,
         reference || null, req.file.filename, path.basename(req.file.originalname).slice(0, 200), req.file.mimetype]
      );
      res.status(201).json({
        message: 'Pedido recebido. O pagamento será verificado manualmente pelo administrador.',
        request_id: id,
        status: 'pending'
      });
    } catch (err) {
      if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
      next(err);
    }
  });
});

app.post('/api/admin/login', loginLimiter, requireSameOrigin, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const result = await pool.query('SELECT id, username, password_hash FROM admin_users WHERE username = $1', [username]);
    const user = result.rows[0];
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!valid) return res.status(401).json({ error: 'Nome de administrador ou palavra-passe incorretos.' });
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    req.session.adminId = user.id;
    req.session.adminUsername = user.username;
    await pool.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    res.json({ message: 'Sessão iniciada.', admin: { username: user.username } });
  } catch (err) { next(err); }
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ authenticated: true, admin: { username: req.session.adminUsername } });
});

app.post('/api/admin/logout', requireSameOrigin, requireAdmin, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('luargram.sid', { httpOnly: true, secure: IS_PROD, sameSite: 'strict' });
    res.json({ message: 'Sessão terminada.' });
  });
});

app.get('/api/admin/payments', requireAdmin, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'pending');
    const allowed = new Set(['pending', 'approved', 'rejected', 'all']);
    if (!allowed.has(status)) return res.status(400).json({ error: 'Filtro de estado inválido.' });
    const result = status === 'all'
      ? await pool.query(`SELECT id, customer_name, account_name, payment_type, amount_kz, payment_method, payment_phone,
          transaction_reference, receipt_original_name, status, admin_note, created_at, reviewed_at
          FROM payment_requests ORDER BY created_at DESC LIMIT 500`)
      : await pool.query(`SELECT id, customer_name, account_name, payment_type, amount_kz, payment_method, payment_phone,
          transaction_reference, receipt_original_name, status, admin_note, created_at, reviewed_at
          FROM payment_requests WHERE status = $1 ORDER BY created_at DESC LIMIT 500`, [status]);
    res.json({ payments: result.rows });
  } catch (err) { next(err); }
});

app.get('/api/admin/payments/:id/receipt', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT receipt_storage_name, receipt_original_name, receipt_mime_type FROM payment_requests WHERE id = $1', [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Pedido não encontrado.' });
    const file = path.join(UPLOAD_DIR, path.basename(result.rows[0].receipt_storage_name));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Ficheiro não encontrado no armazenamento. Confirma o volume persistente.' });
    res.setHeader('Content-Type', result.rows[0].receipt_mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(result.rows[0].receipt_original_name).replace(/["\\]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file);
  } catch (err) { next(err); }
});

app.post('/api/admin/payments/:id/review', requireAdmin, requireSameOrigin, async (req, res, next) => {
  try {
    const status = String(req.body.status || '');
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'A decisão deve ser approved ou rejected.' });
    const result = await pool.query(
      `UPDATE payment_requests SET status = $1, admin_note = $2, reviewed_by = $3, reviewed_at = NOW()
       WHERE id = $4 AND status = 'pending'
       RETURNING id, status, reviewed_at`,
      [status, note || null, req.session.adminId, req.params.id]
    );
    if (!result.rowCount) return res.status(409).json({ error: 'Pedido inexistente ou já analisado.' });
    res.json({ message: status === 'approved' ? 'Pedido aprovado manualmente.' : 'Pedido rejeitado.', payment: result.rows[0] });
  } catch (err) { next(err); }
});

// Never serve uploaded receipts as public static files.
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = Number(err.status) || 500;
  res.status(status).json({ error: status >= 500 ? 'Erro interno. Consulta os registos do servidor.' : err.message });
});

ensureSchemaAndAdmin()
  .then(() => app.listen(PORT, () => console.log(`Luargram backend ativo na porta ${PORT}`)))
  .catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
