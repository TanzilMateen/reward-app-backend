const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.get("/", (req, res) => {
  res.send("Backend is Running Successfully!");
});
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "super_secret_key_99";

// --- MySQL Connection Pool ---
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 10909,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
});

// --- Middlewares ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Access Denied" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Session Expired" });
    req.user = user;
    next();
  });
};

const isAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin Credentials Required" });
  }
  next();
};

// --- 1. AUTHENTICATION ---
app.post("/register", async (req, res) => {
  const { name, email, password, referred_by } = req.body;
  const myReferralCode = "REF" + Math.random().toString(36).substring(2, 8).toUpperCase();

  try {
    const [existing] = await db.execute("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length > 0) return res.status(400).json({ message: "Email already exists!" });

    const hashedPassword = await bcrypt.hash(password, 12);
    
    // 🔥 UPGRADE: Referral par foran paisay nahi milenge (Anti-Fraud)
    await db.execute(
      "INSERT INTO users (name, email, password, referral_code, referred_by, balance, video_points, role, is_active) VALUES (?, ?, ?, ?, ?, 0.00, 0, 'user', 1)",
      [name, email, hashedPassword, myReferralCode, referred_by || null]
    );

    res.status(201).json({ message: "Account created!", referralCode: myReferralCode });
  } catch (error) {
    res.status(500).json({ message: "Registration failed." });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0) return res.status(400).json({ message: "Invalid Credentials" });

    const user = users[0];
    if (user.is_active === 0) return res.status(403).json({ message: "ACCOUNT BLOCKED" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid Credentials" });

    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { name: user.name, role: user.role, id: user.id } });
  } catch (error) {
    res.status(500).json({ message: "Login Error" });
  }
});

// --- 2. USER ACTIONS & REWARDS ---

const lastClaim = new Map();

app.post("/add-video-points", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const now = Date.now();

  // 🔥 ANTI-CHEAT: 20s gap + Fixed Points (Hacker points change nahi kar sakega)
  if (lastClaim.has(userId) && (now - lastClaim.get(userId) < 20000)) {
    return res.status(429).json({ message: "Wait for video to finish!" });
  }

  try {
    const [user] = await db.execute("SELECT is_active, video_points, referred_by FROM users WHERE id = ?", [userId]);
    if (user[0].is_active === 0) return res.status(403).json({ message: "Blocked" });

    const currentPoints = user[0].video_points + 1;
    const reward = 0.50; // Per video fix price

    await db.execute("UPDATE users SET video_points = ?, balance = balance + ? WHERE id = ?", [currentPoints, reward, userId]);

    // 🔥 UPGRADE: Jab user 20 videos dekh le, tab uske inviter ko Rs. 5 milenge
    if (currentPoints === 20 && user[0].referred_by) {
      await db.execute(
        "UPDATE users SET balance = balance + 5.00, active_referrals = active_referrals + 1 WHERE referral_code = ?",
        [user[0].referred_by]
      );
    }

    lastClaim.set(userId, now);
    res.json({ success: true, balanceAdded: reward });
  } catch (error) {
    res.status(500).json({ message: "Update failed" });
  }
});

// 🔥 WITHDRAWAL SYSTEM (Missing in your code)
app.post("/withdraw", authenticateToken, async (req, res) => {
  const { amount, method, details } = req.body;
  const userId = req.user.id;

  try {
    const [user] = await db.execute("SELECT balance FROM users WHERE id = ?", [userId]);
    if (user[0].balance < amount || amount < 500) {
      return res.status(400).json({ message: "Min withdrawal Rs. 500" });
    }

    await db.execute("UPDATE users SET balance = balance - ? WHERE id = ?", [amount, userId]);
    await db.execute(
      "INSERT INTO withdrawals (user_id, amount, method, account_details, status) VALUES (?, ?, ?, ?, 'Pending')",
      [userId, amount, method, details]
    );
    res.json({ message: "Withdrawal request sent!" });
  } catch (err) {
    res.status(500).json({ message: "Withdrawal failed" });
  }
});

// --- 3. ADMIN DASHBOARD API ---

app.get("/admin/withdrawals", authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT w.*, u.name, u.email 
      FROM withdrawals w 
      JOIN users u ON w.user_id = u.id 
      ORDER BY w.created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.post("/admin/update-withdrawal", authenticateToken, isAdmin, async (req, res) => {
  const { id, status, admin_note } = req.body;
  try {
    if (status === 'Rejected') {
      const [w] = await db.execute("SELECT user_id, amount FROM withdrawals WHERE id = ?", [id]);
      await db.execute("UPDATE users SET balance = balance + ? WHERE id = ?", [w[0].amount, w[0].user_id]);
    }
    await db.execute("UPDATE withdrawals SET status = ?, admin_note = ? WHERE id = ?", [status, admin_note, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Update failed" }); }
});

app.post("/admin/toggle-user-status", authenticateToken, isAdmin, async (req, res) => {
  const { id, is_active } = req.body;
  try {
    await db.execute("UPDATE users SET is_active = ? WHERE id = ?", [is_active, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: "Failed" }); }
});

app.get("/user-stats", authenticateToken, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT name, video_points, balance, referral_code, is_active,
      (SELECT COUNT(*) FROM users WHERE referred_by = u.referral_code) as total_referrals
      FROM users u WHERE id = ?`, [req.user.id]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.listen(5000, () => console.log("Server Securely Running..."));

