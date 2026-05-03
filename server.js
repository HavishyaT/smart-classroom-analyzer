// ============================================================
//  EduCore — Smart Classroom Platform  |  server.js  v4.2
//  Express · PostgreSQL · Redis · Socket.io · JWT · bcrypt
// ============================================================
require("dotenv").config();

const express    = require("express");
const http       = require("http");
const cors       = require("cors");
const helmet     = require("helmet");
const morgan     = require("morgan");
const { Pool }   = require("pg");
const redis      = require("redis");
const jwt        = require("jsonwebtoken");
const bcrypt     = require("bcryptjs");
const { Server } = require("socket.io");
const multer     = require("multer");
const path       = require("path");
const crypto     = require("crypto");
const QRCode     = require("qrcode");

const app    = express();
const server = http.createServer(app);

// ── Middleware ────────────────────────────────────────────
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*", credentials: true }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── PostgreSQL ────────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT || "5432"),
  user:     process.env.DB_USER     || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME     || "educore",
  max: 20,
});
db.connect()
  .then(() => console.log("[DB] PostgreSQL connected"))
  .catch(e => console.error("[DB]", e.message));

// ── Redis ─────────────────────────────────────────────────
const redisClient = redis.createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
let redisReady = false;
redisClient.on("connect",      () => { redisReady = true;  console.log("[Redis] Connected"); });
redisClient.on("ready",        () => { redisReady = true; });
redisClient.on("end",          () => { redisReady = false; });
redisClient.on("error",        () => { redisReady = false; });
redisClient.on("reconnecting", () => { redisReady = false; });
(async () => {
  try { await redisClient.connect(); }
  catch (e) { console.warn("[Redis] Unavailable — caching disabled"); }
})();

const CACHE_TTL = 300;
async function cacheGet(k)           { if (!redisReady) return null; try { const v = await redisClient.get(k); return v ? JSON.parse(v) : null; } catch { return null; } }
async function cacheSet(k, v, t=CACHE_TTL) { if (!redisReady) return; try { await redisClient.setEx(k, t, JSON.stringify(v)); } catch {} }
async function cacheDel(k)           { if (!redisReady) return; try { await redisClient.del(k); } catch {} }
async function cacheDelPattern(p)    { if (!redisReady) return; try { const ks = await redisClient.keys(p); if (ks.length) await redisClient.del(ks); } catch {} }

// ── Socket.io ─────────────────────────────────────────────
const io = new Server(server, { cors: { origin: "*" } });
const activeSessions = {};
io.on("connection", socket => {
  socket.on("session:join",   ({ code }) => {
    if (activeSessions[code]) { socket.join(`sess:${code}`); socket.emit("session:joined", activeSessions[code]); }
    else socket.emit("session:invalid");
  });
  socket.on("session:create", ({ code, course, facultyId }) => {
    activeSessions[code] = { code, course, facultyId };
    socket.join(`sess:${code}`);
    io.emit("session:available", { code, course });
  });
  socket.on("doubt:post",        d  => { io.to(`sess:${d.session_code}`).emit("doubt:new", d); io.emit("doubt:board:update", d); });
  socket.on("doubt:answer",      ev => { io.emit("doubt:answered", ev); });
  socket.on("poll:create",       p  => { io.emit("poll:new", p); });
  socket.on("poll:vote",         ev => { io.emit("poll:vote:update", ev); });
  socket.on("announcement:post", a  => { io.emit("announcement:new", a); });
  socket.on("join:user",         ({ userId }) => socket.join(`user:${userId}`));
  socket.on("attendance:marked", d  => io.emit("attendance:update", d));
});

// ── JWT ───────────────────────────────────────────────────
const JWT_SECRET  = process.env.JWT_SECRET  || "educore-secret";
const JWT_REFRESH = process.env.JWT_REFRESH || "educore-refresh";

function generateTokens(payload) {
  return {
    accessToken:  jwt.sign(payload, JWT_SECRET,  { expiresIn: "1h" }),
    refreshToken: jwt.sign({ id: payload.id }, JWT_REFRESH, { expiresIn: "7d" }),
  };
}

function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(e.name === "TokenExpiredError" ? 401 : 403)
       .json({ error: e.name === "TokenExpiredError" ? "Token expired" : "Invalid token" });
  }
}

function facultyOnly(req, res, next) {
  if (req.user?.role !== "faculty") return res.status(403).json({ error: "Faculty only" });
  next();
}

// ── Multer ────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: path.join(__dirname, "uploads"),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString("hex") + "-" + file.originalname),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ── Schema Init ───────────────────────────────────────────
async function initSchema() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS institutions (
      id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL,
      abbr VARCHAR(10) NOT NULL UNIQUE, location VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE institutions ADD COLUMN IF NOT EXISTS image_url TEXT`,

    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, institution_id INT REFERENCES institutions(id),
      name VARCHAR(100) NOT NULL, email VARCHAR(150) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('student','faculty','admin')),
      roll_no VARCHAR(50), created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS face_vector          TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS refresh_token        TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT TRUE`,

    `CREATE TABLE IF NOT EXISTS attendance (id SERIAL PRIMARY KEY, student_id INT, marked_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS session_code  VARCHAR(20)`,
    `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS qr_verified   BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS gps_lat       NUMERIC(10,7)`,
    `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS gps_lng       NUMERIC(10,7)`,
    `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS face_verified BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE attendance ADD COLUMN IF NOT EXISTS status        VARCHAR(20) DEFAULT 'Present'`,

    `CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY, institution_id INT REFERENCES institutions(id),
      posted_by INT REFERENCES users(id), title VARCHAR(300) NOT NULL, body TEXT NOT NULL,
      priority VARCHAR(20) DEFAULT 'Normal' CHECK (priority IN ('Normal','Important','Urgent')),
      created_at TIMESTAMPTZ DEFAULT NOW())`,

    `CREATE TABLE IF NOT EXISTS assignments (
      id SERIAL PRIMARY KEY, student_id INT REFERENCES users(id) ON DELETE CASCADE,
      course VARCHAR(100) NOT NULL, title VARCHAR(300) NOT NULL, notes TEXT,
      file_path TEXT, grade VARCHAR(10) DEFAULT '—', graded_by INT REFERENCES users(id),
      submitted_at TIMESTAMPTZ DEFAULT NOW())`,

    `CREATE TABLE IF NOT EXISTS doubts (
      id SERIAL PRIMARY KEY, session_code VARCHAR(20), subject VARCHAR(100),
      question TEXT NOT NULL, votes INT DEFAULT 0,
      answered BOOLEAN DEFAULT FALSE, answer TEXT,
      answered_by INT REFERENCES users(id), answered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW())`,

    `CREATE TABLE IF NOT EXISTS doubt_votes (
      doubt_id INT REFERENCES doubts(id) ON DELETE CASCADE,
      user_id  INT REFERENCES users(id)  ON DELETE CASCADE,
      PRIMARY KEY (doubt_id, user_id))`,

    `CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY, institution_id INT REFERENCES institutions(id),
      created_by INT REFERENCES users(id), question TEXT NOT NULL,
      options JSONB NOT NULL, votes JSONB NOT NULL,
      is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`,

    `CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id INT REFERENCES polls(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      option_index INT NOT NULL, PRIMARY KEY (poll_id, user_id))`,

    `CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY, student_id INT REFERENCES users(id) ON DELETE CASCADE,
      from_date DATE NOT NULL, to_date DATE NOT NULL,
      leave_type VARCHAR(100) NOT NULL, reason TEXT NOT NULL,
      anonymous BOOLEAN DEFAULT FALSE,
      status VARCHAR(20) DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
      reviewed_by INT REFERENCES users(id), reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW())`,

    `CREATE TABLE IF NOT EXISTS calendar_events (
      id SERIAL PRIMARY KEY, institution_id INT REFERENCES institutions(id),
      title VARCHAR(300) NOT NULL, event_date DATE NOT NULL,
      event_type VARCHAR(20) DEFAULT 'event' CHECK (event_type IN ('holiday','exam','leave','event')),
      circular_no VARCHAR(50), body TEXT, created_by INT REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW())`,

    `CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, message TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE`,
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type    VARCHAR(30) DEFAULT 'info'`,
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE`,

    `CREATE TABLE IF NOT EXISTS reminders (id SERIAL PRIMARY KEY, title VARCHAR(300) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS user_id   INT REFERENCES users(id) ON DELETE CASCADE`,
    `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS remind_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS category  VARCHAR(50) DEFAULT 'Other'`,
    `ALTER TABLE reminders ADD COLUMN IF NOT EXISTS is_done   BOOLEAN DEFAULT FALSE`,

    `CREATE TABLE IF NOT EXISTS session_codes (
      code VARCHAR(20) PRIMARY KEY, course VARCHAR(100) NOT NULL,
      created_by INT REFERENCES users(id), institution_id INT REFERENCES institutions(id),
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE session_codes ADD COLUMN IF NOT EXISTS qr_data TEXT`,

    `CREATE INDEX IF NOT EXISTS idx_att_student   ON attendance(student_id)`,
    `CREATE INDEX IF NOT EXISTS idx_att_session   ON attendance(session_code)`,
    `CREATE INDEX IF NOT EXISTS idx_doubts_sess   ON doubts(session_code)`,
    `CREATE INDEX IF NOT EXISTS idx_notif_user    ON notifications(user_id, is_read)`,
    `CREATE INDEX IF NOT EXISTS idx_leave_student ON leave_requests(student_id)`,
    `CREATE INDEX IF NOT EXISTS idx_asgn_student  ON assignments(student_id)`,

    `INSERT INTO institutions (name, abbr, location, image_url) VALUES
  ('Mahindra University','MU','Hyderabad, Telangana','https://images.unsplash.com/photo-1562774053-701939374585?w=800&q=80'),
  ('IIT Hyderabad','IITH','Sangareddy, Telangana','https://images.unsplash.com/photo-1607237138185-eedd9c632b0b?w=800&q=80'),
  ('BITS Pilani','BITS','Pilani, Rajasthan','https://images.unsplash.com/photo-1541339907198-e08756dedf3f?w=800&q=80'),
  ('VIT Vellore','VIT','Vellore, Tamil Nadu','https://images.unsplash.com/photo-1523050854058-8df90110c9f1?w=800&q=80'),
  ('JNTU Hyderabad','JNTU','Hyderabad, Telangana','https://images.unsplash.com/photo-1498243691581-b145c3f54a5a?w=800&q=80'),
  ('Amrita University','AU','Coimbatore, Tamil Nadu','https://images.unsplash.com/photo-1527576539890-dfa815648363?w=800&q=80')
ON CONFLICT (abbr) DO UPDATE SET image_url = EXCLUDED.image_url`,
  ];

  let warns = 0;
  for (const sql of stmts) {
    try { await db.query(sql); }
    catch (e) { console.warn("[DB] Migration warning:", e.message.split("\n")[0]); warns++; }
  }
  console.log(`[DB] Schema initialised${warns ? ` with ${warns} warning(s)` : ""}`);
  await seedDemoUsers();
}

async function seedDemoUsers() {
  const hash = await bcrypt.hash("1234", 10);
  const inst = await db.query("SELECT id FROM institutions WHERE abbr='MU'");
  const instId = inst.rows[0]?.id;
  if (!instId) return;

  const users = [
    { name: "Chandrika",         email: "se23uari002@mu.edu", roll_no: "SE23UARI002", role: "student" },
    { name: "Varshitha",         email: "se23uari022@mu.edu", roll_no: "SE23UARI022", role: "student" },
    { name: "Havishya",          email: "se23uari098@mu.edu", roll_no: "SE23UARI098", role: "student" },
    { name: "Subba Rao",         email: "se23uari068@mu.edu", roll_no: "SE23UARI068", role: "student" },
    { name: "Ramaraju",          email: "se23uari024@mu.edu", roll_no: "SE23UARI024", role: "student" },
    { name: "Hrishikeswar Reddy",email: "se23uari036@mu.edu", roll_no: "SE23UARI036", role: "student" },
    { name: "Krushith Rao",      email: "se23ucse227@mu.edu", roll_no: "SE23UCSE227", role: "student" },
    { name: "Vidhur Rao",        email: "se23ucse207@mu.edu", roll_no: "SE23UCSE207", role: "student" },
    { name: "Dr. Narthkannai",   email: "narthkannai@mu.edu", roll_no: null,           role: "faculty" },
    { name: "Dr. Ramesh Babu",   email: "ramesh.babu@mu.edu", roll_no: null,           role: "faculty" },
    { name: "Prof. Sunitha Rani",email: "sunitha.rani@mu.edu",roll_no: null,           role: "faculty" },
    { name: "Dr. Venkat Prasad", email: "venkat.prasad@mu.edu",roll_no: null,          role: "faculty" },
    { name: "Prof. Lakshmi Devi",email: "lakshmi.devi@mu.edu",roll_no: null,           role: "faculty" },
    { name: "Dr. Kiran Sai",     email: "kiran.sai@mu.edu",   roll_no: null,           role: "faculty" },
    { name: "Prof. Aruna Kumari",email: "aruna.kumari@mu.edu",roll_no: null,           role: "faculty" },
  ];

  for (const u of users) {
    await db.query(
      `INSERT INTO users (institution_id,name,email,password_hash,role,roll_no,must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE) ON CONFLICT (email) DO NOTHING`,
      [instId, u.name, u.email, hash, u.role, u.roll_no]
    );
  }

  const fac = await db.query("SELECT id FROM users WHERE email='faculty@mu.edu'");
  const facId = fac.rows[0]?.id;
  if (facId) {
    const anns = [
      ["Mid-Semester Examination Schedule","Mid-semester exams commence March 25. Hall tickets on portal. Bring ID card.","Important"],
      ["Campus Network Maintenance","WiFi unavailable Sunday 22:00–Monday 06:00 for infrastructure upgrades.","Normal"],
      ["EduHack 2026 — Registrations Open","Teams of 2–4. Deadline: March 30. Prize pool ₹2,00,000.","Normal"],
    ];
    for (const [title, body, priority] of anns) {
      await db.query(
        `INSERT INTO announcements (institution_id,posted_by,title,body,priority) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [instId, facId, title, body, priority]
      ).catch(() => {});
    }
    const calEvents = [
      ["Holi — National Holiday","2026-03-21","holiday","CIRC/2026/031"],
      ["Mid-Sem: Machine Learning","2026-03-25","exam",null],
      ["Mid-Sem: Software Engineering","2026-03-26","exam",null],
      ["Good Friday","2026-03-28","holiday","CIRC/2026/028"],
      ["Mid-Sem: Computer Networks","2026-04-01","exam",null],
      ["Dr. Ambedkar Jayanti","2026-04-14","holiday","CIRC/2026/041"],
    ];
    for (const [title, date, type, circ] of calEvents) {
      await db.query(
        `INSERT INTO calendar_events (institution_id,title,event_date,event_type,circular_no,created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [instId, title, date, type, circ, facId]
      ).catch(() => {});
    }
  }
  await db.query(`UPDATE institutions SET image_url='https://images.unsplash.com/photo-1562774053-701939374585?w=800&q=80' WHERE abbr='MU'`);
  await db.query(`UPDATE institutions SET image_url='https://images.unsplash.com/photo-1607237138185-eedd9c632b0b?w=800&q=80' WHERE abbr='IITH'`);
  await db.query(`UPDATE institutions SET image_url='https://images.unsplash.com/photo-1541339907198-e08756dedf3f?w=800&q=80' WHERE abbr='BITS'`);
  await db.query(`UPDATE institutions SET image_url='https://images.unsplash.com/photo-1523050854058-8df90110c9f1?w=800&q=80' WHERE abbr='VIT'`);
  await db.query(`UPDATE institutions SET image_url='https://images.unsplash.com/photo-1498243691581-b145c3f54a5a?w=800&q=80' WHERE abbr='JNTU'`);
  await db.query(`UPDATE institutions SET image_url='https://images.unsplash.com/photo-1527576539890-dfa815648363?w=800&q=80' WHERE abbr='AU'`);
  await cacheDel("institutions:all");
  console.log("[DB] Demo users seeded");
}

// ════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════

app.get("/api/health", async (req, res) => {
  const dbOk = await db.query("SELECT 1").then(() => true).catch(() => false);
  res.json({ status: "ok", db: dbOk ? "connected" : "error", redis: redisReady ? "connected" : "error" });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── AUTH ──────────────────────────────────────────────────

// ╔══════════════════════════════════════════════════════════╗
// ║  FIX: Login now correctly handles ALL three input forms: ║
// ║  1. Full email:   se23uari002@mu.edu                     ║
// ║  2. Roll number:  se23uari002  (any case)                ║
// ║  3. Roll number:  SE23UARI002  (uppercase)               ║
// ║                                                          ║
// ║  Root cause of the bug: the old code built an email      ║
// ║  string from roll number input and then used that SAME   ║
// ║  string for both the email AND roll_no WHERE clauses.    ║
// ║  So roll_no = UPPER('se23uari002@mu.edu') never matched. ║
// ║                                                          ║
// ║  Fix: separate $1 (email) and $2 (roll_no) params so     ║
// ║  each column gets the right value to compare against.    ║
// ╚══════════════════════════════════════════════════════════╝
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email/roll number and password required" });

  try {
    const input = email.trim();

    // Determine what was typed: email or roll number
    const isEmail   = input.includes("@");
    // Email to query: if roll no typed without @, append @mu.edu so the email column matches
    const emailVal  = isEmail ? input.toLowerCase() : `${input.toLowerCase()}@mu.edu`;
    // Roll no to query: always the raw input uppercased (roll_no column stores uppercase)
    const rollVal   = input.toUpperCase();

    // FIX: Use TWO separate params — $1 for email, $2 for roll_no
    // This way each column gets the correctly formatted value
    const result = await db.query(
      `SELECT u.*, i.name AS inst_name, i.abbr AS inst_abbr, i.location AS inst_loc,
              COALESCE(i.image_url,'') AS inst_img
       FROM users u
       LEFT JOIN institutions i ON u.institution_id = i.id
       WHERE LOWER(u.email) = $1
          OR UPPER(u.roll_no) = $2`,
      [emailVal, rollVal]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Invalid credentials — check email/roll number" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials — wrong password" });

    const payload = { id: user.id, email: user.email, name: user.name, role: user.role, inst: user.inst_abbr };
    const tokens  = generateTokens(payload);

    await db.query("UPDATE users SET refresh_token=$1 WHERE id=$2", [tokens.refreshToken, user.id]);
    await cacheSet(`session:${user.id}`, { ...payload, inst_name: user.inst_name, inst_loc: user.inst_loc }, 3600);
    await db.query(
      "INSERT INTO notifications (user_id,message,type) VALUES ($1,$2,$3)",
      [user.id, "Signed in successfully.", "info"]
    ).catch(() => {});

    res.json({
      ...tokens,
      user: {
        id:                   user.id,
        name:                 user.name,
        email:                user.email,
        role:                 user.role,
        roll_no:              user.roll_no,
        inst:                 user.inst_abbr,
        inst_name:            user.inst_name,
        inst_loc:             user.inst_loc,
        inst_img:             user.inst_img,
        must_change_password: user.must_change_password,
        has_face:             !!user.face_vector,
      },
    });
  } catch (e) {
    console.error("[Login]", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Face enrollment
app.post("/api/auth/face/enroll", authMiddleware, async (req, res) => {
  const { faceDescriptor } = req.body;
  if (!faceDescriptor) return res.status(400).json({ error: "faceDescriptor required" });
  try {
    await db.query("UPDATE users SET face_vector=$1 WHERE id=$2", [JSON.stringify(faceDescriptor), req.user.id]);
    await cacheDel(`session:${req.user.id}`);
    res.json({ message: "Face enrolled successfully." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Face login
app.post("/api/auth/face/login", async (req, res) => {
  const { faceDescriptor } = req.body;
  if (!faceDescriptor) return res.status(400).json({ error: "faceDescriptor required" });
  try {
    const all = await db.query(
      `SELECT u.*, i.name AS inst_name, i.abbr AS inst_abbr, i.location AS inst_loc,
              COALESCE(i.image_url,'') AS inst_img
       FROM users u
       LEFT JOIN institutions i ON u.institution_id = i.id
       WHERE u.face_vector IS NOT NULL`
    );
    const input = faceDescriptor;
    let best = null, bestScore = Infinity;
    for (const row of all.rows) {
      try {
        const stored = JSON.parse(row.face_vector);
        // Euclidean distance — lower is better
        const dist = Math.sqrt(stored.reduce((sum, v, i) => sum + (v - input[i]) ** 2, 0));
        if (dist < bestScore) { bestScore = dist; best = row; }
      } catch {}
    }
    // Threshold: euclidean distance < 0.6 is a match (face-api.js convention)
    if (!best || bestScore > 0.6) {
      return res.status(401).json({ error: "Face not recognised. Log in with roll number first." });
    }
    const payload = { id: best.id, email: best.email, name: best.name, role: best.role, inst: best.inst_abbr };
    const tokens  = generateTokens(payload);
    await db.query("UPDATE users SET refresh_token=$1 WHERE id=$2", [tokens.refreshToken, best.id]);
    await cacheSet(`session:${best.id}`, payload, 3600);
    res.json({
      ...tokens,
      user: {
        id: best.id, name: best.name, email: best.email, role: best.role,
        roll_no: best.roll_no, inst: best.inst_abbr, inst_name: best.inst_name,
        inst_loc: best.inst_loc, inst_img: best.inst_img,
        must_change_password: best.must_change_password, has_face: true,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: "Refresh token required" });
  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH);
    const result  = await db.query("SELECT * FROM users WHERE id=$1 AND refresh_token=$2", [decoded.id, refreshToken]);
    if (!result.rows.length) return res.status(403).json({ error: "Invalid refresh token" });
    const user    = result.rows[0];
    const payload = { id: user.id, email: user.email, name: user.name, role: user.role };
    const tokens  = generateTokens(payload);
    await db.query("UPDATE users SET refresh_token=$1 WHERE id=$2", [tokens.refreshToken, user.id]);
    res.json(tokens);
  } catch { res.status(403).json({ error: "Invalid refresh token" }); }
});

app.post("/api/auth/logout", authMiddleware, async (req, res) => {
  await db.query("UPDATE users SET refresh_token=NULL WHERE id=$1", [req.user.id]);
  await cacheDel(`session:${req.user.id}`);
  res.json({ message: "Logged out" });
});

app.post("/api/auth/change-password", authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 4)
    return res.status(400).json({ error: "Both passwords required; new must be ≥4 chars" });
  try {
    const r = await db.query("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
    if (!await bcrypt.compare(currentPassword, r.rows[0].password_hash))
      return res.status(401).json({ error: "Current password incorrect" });
    await db.query(
      "UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2",
      [await bcrypt.hash(newPassword, 10), req.user.id]
    );
    await cacheDel(`session:${req.user.id}`);
    res.json({ message: "Password changed successfully" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INSTITUTIONS ──────────────────────────────────────────
app.get("/api/institutions", async (req, res) => {
  try {
    await cacheDel("institutions:all");
    const cached = await cacheGet("institutions:all");
    if (cached) return res.json({ data: cached, cached: true });
    const r = await db.query("SELECT id,name,abbr,location,COALESCE(image_url,'') AS image_url FROM institutions ORDER BY name");
    if (r.rows.length) await cacheSet("institutions:all", r.rows, 3600);
    res.json({ data: r.rows });
  } catch (e) {
    try {
      const r = await db.query("SELECT id,name,abbr,location FROM institutions ORDER BY name");
      res.json({ data: r.rows.map(row => ({ ...row, image_url: "" })) });
    } catch (e2) { res.status(500).json({ error: e2.message }); }
  }
});

// ── SESSIONS (QR Generation) ──────────────────────────────
app.post("/api/sessions", authMiddleware, facultyOnly, async (req, res) => {
  const { course } = req.body;
  if (!course) return res.status(400).json({ error: "course required" });
  try {
    const chars     = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code      = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const expiresAt = new Date(Date.now() + 90 * 60 * 1000);
    const userRow   = await db.query("SELECT institution_id FROM users WHERE id=$1", [req.user.id]);
    const instId    = userRow.rows[0]?.institution_id;

    const qrPayload = JSON.stringify({ code, course, ts: Date.now() });
    const qrDataUrl = await QRCode.toDataURL(qrPayload, {
      width: 300, margin: 2,
      color: { dark: "#3b6bff", light: "#0a0b0d" },
    });

    await db.query(
      "INSERT INTO session_codes (code,course,created_by,institution_id,expires_at,qr_data) VALUES ($1,$2,$3,$4,$5,$6)",
      [code, course, req.user.id, instId, expiresAt, qrDataUrl]
    );
    await cacheSet(`session_code:${code}`, { code, course, facultyId: req.user.id }, 5400);
    io.emit("session:available", { code, course });
    res.json({ data: { code, course, expires_at: expiresAt, qr: qrDataUrl } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/sessions/validate/:code", authMiddleware, async (req, res) => {
  const code   = req.params.code.toUpperCase();
  const cached = await cacheGet(`session_code:${code}`);
  if (cached) return res.json({ valid: true, data: cached });
  const r = await db.query("SELECT * FROM session_codes WHERE code=$1 AND expires_at>NOW()", [code]);
  if (!r.rows.length) return res.json({ valid: false });
  await cacheSet(`session_code:${code}`, r.rows[0], 300);
  res.json({ valid: true, data: r.rows[0] });
});

app.get("/api/sessions/:code/qr", authMiddleware, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const r    = await db.query("SELECT qr_data FROM session_codes WHERE code=$1 AND expires_at>NOW()", [code]);
  if (!r.rows.length) return res.status(404).json({ error: "Session not found or expired" });
  res.json({ qr: r.rows[0].qr_data });
});

// ── ATTENDANCE ────────────────────────────────────────────
app.post("/api/attendance", authMiddleware, async (req, res) => {
  const { session_code, qr_verified, gps_lat, gps_lng, face_verified } = req.body;
  if (!session_code) return res.status(400).json({ error: "session_code required" });
  try {
    const sc = await db.query("SELECT * FROM session_codes WHERE code=$1 AND expires_at>NOW()", [session_code]);
    if (!sc.rows.length) return res.status(400).json({ error: "Invalid or expired session code" });
    const dup = await db.query("SELECT id FROM attendance WHERE student_id=$1 AND session_code=$2", [req.user.id, session_code]);
    if (dup.rows.length) return res.status(409).json({ error: "Already marked for this session" });
    const r = await db.query(
      "INSERT INTO attendance (student_id,session_code,qr_verified,gps_lat,gps_lng,face_verified) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [req.user.id, session_code, qr_verified ?? false, gps_lat, gps_lng, face_verified ?? false]
    );
    await cacheDel(`attendance:${req.user.id}`);
    await cacheDel(`analytics:${req.user.id}`);
    await db.query("INSERT INTO notifications (user_id,message,type) VALUES ($1,$2,$3)",
      [req.user.id, `Attendance marked for session ${session_code}`, "success"]).catch(() => {});
    io.emit("attendance:marked", { studentId: req.user.id, session: session_code });
    res.json({ data: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/attendance", authMiddleware, async (req, res) => {
  const sid    = req.user.role === "faculty" ? (req.query.student_id || req.user.id) : req.user.id;
  const cached = await cacheGet(`attendance:${sid}`);
  if (cached) return res.json({ data: cached, cached: true });
  const r = await db.query(
    "SELECT a.*,sc.course FROM attendance a LEFT JOIN session_codes sc ON a.session_code=sc.code WHERE a.student_id=$1 ORDER BY a.marked_at DESC LIMIT 50",
    [sid]
  );
  await cacheSet(`attendance:${sid}`, r.rows, 120);
  res.json({ data: r.rows });
});

app.get("/api/analytics", authMiddleware, async (req, res) => {
  const sid    = req.user.role === "faculty" ? (req.query.student_id || req.user.id) : req.user.id;
  const cached = await cacheGet(`analytics:${sid}`);
  if (cached) return res.json({ data: cached, cached: true });
  const total  = 20;
  const r      = await db.query("SELECT COUNT(*) AS attended FROM attendance WHERE student_id=$1", [sid]);
  const attended   = parseInt(r.rows[0].attended);
  const percentage = Math.round((attended / total) * 100);
  const data   = { total, attended, percentage, below75: percentage < 75 };
  await cacheSet(`analytics:${sid}`, data, 60);
  res.json({ data });
});

// ── ANNOUNCEMENTS ─────────────────────────────────────────
app.get("/api/announcements", authMiddleware, async (req, res) => {
  const cached = await cacheGet("announcements:all");
  if (cached) return res.json({ data: cached, cached: true });
  const r = await db.query(
    "SELECT a.*,u.name AS posted_by_name FROM announcements a LEFT JOIN users u ON a.posted_by=u.id ORDER BY a.created_at DESC LIMIT 20"
  );
  await cacheSet("announcements:all", r.rows, 120);
  res.json({ data: r.rows });
});

app.post("/api/announcements", authMiddleware, facultyOnly, async (req, res) => {
  const { title, body, priority } = req.body;
  if (!title || !body) return res.status(400).json({ error: "title and body required" });
  const u = await db.query("SELECT institution_id FROM users WHERE id=$1", [req.user.id]);
  const r = await db.query(
    "INSERT INTO announcements (institution_id,posted_by,title,body,priority) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [u.rows[0]?.institution_id, req.user.id, title, body, priority || "Normal"]
  );
  await cacheDelPattern("announcements:*");
  io.emit("announcement:new", r.rows[0]);
  res.json({ data: r.rows[0] });
});

// ── ASSIGNMENTS ───────────────────────────────────────────
app.post("/api/assignments", authMiddleware, upload.single("file"), async (req, res) => {
  const { title, course, notes } = req.body;
  if (!title || !course) return res.status(400).json({ error: "title and course required" });
  const r = await db.query(
    "INSERT INTO assignments (student_id,course,title,notes,file_path) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [req.user.id, course, title, notes, req.file?.path || null]
  );
  await cacheDel(`assignments:${req.user.id}`);
  res.json({ data: r.rows[0] });
});

app.get("/api/assignments", authMiddleware, async (req, res) => {
  const sid    = req.user.role === "faculty" ? req.query.student_id : req.user.id;
  const cached = await cacheGet(`assignments:${sid}`);
  if (cached) return res.json({ data: cached, cached: true });
  const r = await db.query("SELECT * FROM assignments WHERE student_id=$1 ORDER BY submitted_at DESC", [sid]);
  await cacheSet(`assignments:${sid}`, r.rows, 120);
  res.json({ data: r.rows });
});

app.patch("/api/assignments/:id/grade", authMiddleware, facultyOnly, async (req, res) => {
  const r = await db.query(
    "UPDATE assignments SET grade=$1,graded_by=$2 WHERE id=$3 RETURNING *",
    [req.body.grade, req.user.id, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: "Not found" });
  await cacheDel(`assignments:${r.rows[0].student_id}`);
  await db.query("INSERT INTO notifications (user_id,message,type) VALUES ($1,$2,$3)",
    [r.rows[0].student_id, `Assignment "${r.rows[0].title}" graded: ${req.body.grade}`, "info"]).catch(() => {});
  res.json({ data: r.rows[0] });
});

// ── DOUBTS ────────────────────────────────────────────────
app.get("/api/doubts", authMiddleware, async (req, res) => {
  const { session, filter } = req.query;
  const cacheKey = `doubts:${session || "all"}:${filter || "all"}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return res.json({ data: cached, cached: true });
  let where = "1=1"; const params = [];
  if (session) { params.push(session); where += ` AND session_code=$${params.length}`; }
  if (filter === "answered")   where += " AND answered=TRUE";
  if (filter === "unanswered") where += " AND answered=FALSE";
  const r = await db.query(
    `SELECT d.*,u.name AS answered_by_name FROM doubts d LEFT JOIN users u ON d.answered_by=u.id WHERE ${where} ORDER BY d.votes DESC,d.created_at DESC LIMIT 50`,
    params
  );
  await cacheSet(cacheKey, r.rows, 30);
  res.json({ data: r.rows });
});

app.post("/api/doubts", authMiddleware, async (req, res) => {
  const { session_code, subject, question } = req.body;
  if (!question) return res.status(400).json({ error: "question required" });
  const r = await db.query(
    "INSERT INTO doubts (session_code,subject,question) VALUES ($1,$2,$3) RETURNING *",
    [session_code, subject, question]
  );
  await cacheDelPattern(`doubts:${session_code || "all"}:*`);
  io.to(`sess:${session_code}`).emit("doubt:new", r.rows[0]);
  io.emit("doubt:board:update", r.rows[0]);
  res.json({ data: r.rows[0] });
});

app.post("/api/doubts/:id/vote", authMiddleware, async (req, res) => {
  const id = req.params.id;
  const ex = await db.query("SELECT 1 FROM doubt_votes WHERE doubt_id=$1 AND user_id=$2", [id, req.user.id]);
  if (ex.rows.length) {
    await db.query("DELETE FROM doubt_votes WHERE doubt_id=$1 AND user_id=$2", [id, req.user.id]);
    const r = await db.query("UPDATE doubts SET votes=votes-1 WHERE id=$1 RETURNING votes", [id]);
    await cacheDelPattern("doubts:*");
    return res.json({ voted: false, votes: r.rows[0]?.votes });
  }
  await db.query("INSERT INTO doubt_votes (doubt_id,user_id) VALUES ($1,$2)", [id, req.user.id]);
  const r = await db.query("UPDATE doubts SET votes=votes+1 WHERE id=$1 RETURNING votes", [id]);
  await cacheDelPattern("doubts:*");
  res.json({ voted: true, votes: r.rows[0]?.votes });
});

app.post("/api/doubts/:id/answer", authMiddleware, facultyOnly, async (req, res) => {
  const { answer } = req.body;
  const r = await db.query(
    "UPDATE doubts SET answer=$1,answered=TRUE,answered_by=$2,answered_at=NOW() WHERE id=$3 RETURNING *",
    [answer, req.user.id, req.params.id]
  );
  await cacheDelPattern("doubts:*");
  io.emit("doubt:answered", { doubtId: parseInt(req.params.id), answer });
  res.json({ data: r.rows[0] });
});

// ── POLLS ─────────────────────────────────────────────────
app.get("/api/polls", authMiddleware, async (req, res) => {
  const r = await db.query(
    `SELECT p.*,u.name AS created_by_name,
            (SELECT option_index FROM poll_votes WHERE poll_id=p.id AND user_id=$1 LIMIT 1) AS my_vote
     FROM polls p LEFT JOIN users u ON p.created_by=u.id
     WHERE p.is_active=TRUE ORDER BY p.created_at DESC`,
    [req.user.id]
  );
  res.json({ data: r.rows });
});

app.post("/api/polls", authMiddleware, facultyOnly, async (req, res) => {
  const { question, options } = req.body;
  if (!question || !Array.isArray(options) || options.length < 2)
    return res.status(400).json({ error: "question + ≥2 options required" });
  const u = await db.query("SELECT institution_id FROM users WHERE id=$1", [req.user.id]);
  const r = await db.query(
    "INSERT INTO polls (institution_id,created_by,question,options,votes) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [u.rows[0]?.institution_id, req.user.id, question, JSON.stringify(options), JSON.stringify(options.map(() => 0))]
  );
  io.emit("poll:new", r.rows[0]);
  res.json({ data: r.rows[0] });
});

app.post("/api/polls/:id/vote", authMiddleware, async (req, res) => {
  const { option_index } = req.body;
  const ex = await db.query("SELECT 1 FROM poll_votes WHERE poll_id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  if (ex.rows.length) return res.status(409).json({ error: "Already voted" });
  await db.query("INSERT INTO poll_votes (poll_id,user_id,option_index) VALUES ($1,$2,$3)", [req.params.id, req.user.id, option_index]);
  await db.query(
    `UPDATE polls SET votes=jsonb_set(votes,ARRAY[$1::text],(COALESCE((votes->$1::text)::int,0)+1)::text::jsonb) WHERE id=$2`,
    [option_index, req.params.id]
  );
  io.emit("poll:vote:update", { pollId: parseInt(req.params.id), optionIndex: option_index });
  res.json({ message: "Voted" });
});

// ── LEAVES ────────────────────────────────────────────────
app.post("/api/leaves", authMiddleware, async (req, res) => {
  const { from_date, to_date, leave_type, reason, anonymous } = req.body;
  if (!from_date || !to_date || !leave_type || !reason)
    return res.status(400).json({ error: "All fields required" });
  const r = await db.query(
    "INSERT INTO leave_requests (student_id,from_date,to_date,leave_type,reason,anonymous) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
    [req.user.id, from_date, to_date, leave_type, anonymous ? "[Anonymous]" : reason, anonymous || false]
  );
  io.emit("leave:new", { studentId: req.user.id });
  res.json({ data: r.rows[0] });
});

app.get("/api/leaves", authMiddleware, async (req, res) => {
  const r = req.user.role === "student"
    ? await db.query("SELECT * FROM leave_requests WHERE student_id=$1 ORDER BY created_at DESC", [req.user.id])
    : await db.query("SELECT lr.*,u.name AS student_name FROM leave_requests lr LEFT JOIN users u ON lr.student_id=u.id ORDER BY lr.created_at DESC LIMIT 50");
  res.json({ data: r.rows });
});

app.patch("/api/leaves/:id", authMiddleware, facultyOnly, async (req, res) => {
  const { status } = req.body;
  const r = await db.query(
    "UPDATE leave_requests SET status=$1,reviewed_by=$2,reviewed_at=NOW() WHERE id=$3 RETURNING *",
    [status, req.user.id, req.params.id]
  );
  if (!r.rows.length) return res.status(404).json({ error: "Not found" });
  await db.query("INSERT INTO notifications (user_id,message,type) VALUES ($1,$2,$3)",
    [r.rows[0].student_id, `Leave request ${status.toLowerCase()}`, status === "Approved" ? "success" : "warning"]
  ).catch(() => {});
  res.json({ data: r.rows[0] });
});

// ── CALENDAR ──────────────────────────────────────────────
app.get("/api/calendar", authMiddleware, async (req, res) => {
  const cached = await cacheGet("calendar:all");
  if (cached) return res.json({ data: cached, cached: true });
  const r = await db.query("SELECT * FROM calendar_events ORDER BY event_date ASC");
  await cacheSet("calendar:all", r.rows, 600);
  res.json({ data: r.rows });
});

app.post("/api/calendar", authMiddleware, async (req, res) => {
  const { title, event_date, event_type, circular_no, body } = req.body;
  const u = await db.query("SELECT institution_id FROM users WHERE id=$1", [req.user.id]);
  const r = await db.query(
    "INSERT INTO calendar_events (institution_id,title,event_date,event_type,circular_no,body,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
    [u.rows[0]?.institution_id, title, event_date, event_type || "event", circular_no, body, req.user.id]
  );
  await cacheDel("calendar:all");
  res.json({ data: r.rows[0] });
});

// ── NOTIFICATIONS ─────────────────────────────────────────
app.get("/api/notifications", authMiddleware, async (req, res) => {
  const r = await db.query(
    "SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",
    [req.user.id]
  );
  res.json({ data: r.rows });
});

app.patch("/api/notifications/read-all", authMiddleware, async (req, res) => {
  await db.query("UPDATE notifications SET is_read=TRUE WHERE user_id=$1", [req.user.id]);
  res.json({ message: "All read" });
});

// ── REMINDERS ─────────────────────────────────────────────
app.get("/api/reminders", authMiddleware, async (req, res) => {
  const r = await db.query(
    "SELECT * FROM reminders WHERE user_id=$1 AND is_done=FALSE ORDER BY remind_at ASC",
    [req.user.id]
  );
  res.json({ data: r.rows });
});

app.post("/api/reminders", authMiddleware, async (req, res) => {
  const { title, remind_at, category } = req.body;
  if (!title || !remind_at) return res.status(400).json({ error: "title and remind_at required" });
  const r = await db.query(
    "INSERT INTO reminders (user_id,title,remind_at,category) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.user.id, title, remind_at, category || "Other"]
  );
  res.json({ data: r.rows[0] });
});

// ── ERROR HANDLER ─────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, req, res, next) => {
  console.error("[Error]", err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// ── START ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000");
server.listen(PORT, async () => {
  console.log(`\n  EduCore Server running on http://localhost:${PORT}\n`);
  await initSchema();
});

module.exports = { app, server, io, db };
