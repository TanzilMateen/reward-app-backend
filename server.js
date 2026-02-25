const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";

// --- MySQL Connection Pool (Vercel & Aiven Optimized) ---
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 10909,
  ssl: {
    rejectUnauthorized: false, // Vercel ke liye ye nihayat zaroori hai
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// --- Middleware: Token Authentication ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) return res.status(401).json({ message: "No Token Provided" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Session Expired" });
    req.user = user;
    next();
  });
};

// --- Middleware: Admin Check ---
const isAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Access Denied: Admin Only" });
  }
  next();
};

// --- Health Check (Sab se pehle check karne ke liye) ---
app.get("/health", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT 1");
    res.json({ 
      status: "OK", 
      database: "Connected", 
      message: "Ustad! Backend is live and kicking!" 
    });
  } catch (err) {
    res.status(500).json({ 
      status: "Error", 
      message: "Database connection failed", 
      error: err.message 
    });
  }
});

// --- 1. AUTHENTICATION ---
app.post("/register", async (req, res) => {
  const { name, email, password, referred_by } = req.body;
  const myReferralCode = "REF" + Math.floor(100000 + Math.random() * 900000);

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.execute("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({ message: "Email already registered!" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const finalReferrer = referred_by && referred_by.trim() !== "" && referred_by !== "undefined" ? referred_by : null;

    await connection.execute(
      "INSERT INTO users (name, email, password, referral_code, referred_by, balance, video_points, referral_points, role, is_active) VALUES (?, ?, ?, ?, ?, 0.00, 0, 0, 'user', 1)",
      [name, email, hashedPassword, myReferralCode, finalReferrer]
    );

    if (finalReferrer) {
      const [refCheck] = await connection.execute("SELECT id FROM users WHERE referral_code = ?", [finalReferrer]);
      if (refCheck.length > 0) {
        await connection.execute(
          "UPDATE users SET referral_points = referral_points + 100, balance = balance + 1.00 WHERE referral_code = ?",
          [finalReferrer]
        );
      }
    }

    await connection.commit();
    res.status(201).json({ message: "Registration Successful!", referralCode: myReferralCode });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(error);
    res.status(500).json({ message: "Signup failed" });
  } finally {
    if (connection) connection.release();
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await db.execute("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0) return res.status(400).json({ message: "User not found" });

    const user = users[0];
    if (user.is_active === 0) return res.status(403).json({ message: "Your account is suspended by admin." });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid Password" });

    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, user: { name: user.name, role: user.role, id: user.id } });
  } catch (error) {
    res.status(500).json({ message: "Login error" });
  }
});

// --- 2. USER STATS ---
app.get("/user-stats", authenticateToken, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT name, video_points, referral_points, balance, referral_code, is_active,
      (SELECT COUNT(*) FROM users WHERE referred_by = u.referral_code) as total_referrals
      FROM users u WHERE id = ?`,
      [req.user.id]
    );

    if (rows.length === 0) return res.status(404).json({ message: "User not found" });
    if (rows[0].is_active === 0) return res.status(403).json({ message: "Blocked" });

    res.json({
      name: rows[0].name,
      videoPoints: Number(rows[0].video_points),
      referralPoints: Number(rows[0].referral_points),
      balance: parseFloat(rows[0].balance),
      referrals: Number(rows[0].total_referrals),
      referralCode: rows[0].referral_code,
    });
  } catch (error) {
    res.status(500).json({ message: "Fetch stats error" });
  }
});

// --- 3. POINTS & WITHDRAWAL ---
app.post("/add-video-points", authenticateToken, async (req, res) => {
  try {
    const [user] = await db.execute("SELECT is_active FROM users WHERE id = ?", [req.user.id]);
    if (user[0].is_active === 0) return res.status(403).json({ message: "Account Blocked" });

    await db.execute("UPDATE users SET video_points = video_points + 50, balance = balance + 0.50 WHERE id = ?", [
      req.user.id,
    ]);
    res.json({ success: true, message: "Reward Added to Balance!" });
  } catch (error) {
    res.status(500).json({ message: "Points update failed" });
  }
});

app.post("/withdraw", authenticateToken, async (req, res) => {
  const { amount, method, accountDetails } = req.body;
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [user] = await connection.execute("SELECT balance, is_active FROM users WHERE id = ? FOR UPDATE", [
      req.user.id,
    ]);

    if (user[0].is_active === 0) {
      await connection.rollback();
      return res.status(403).json({ message: "Account Blocked" });
    }

    if (parseFloat(user[0].balance) < parseFloat(amount)) {
      await connection.rollback();
      return res.status(400).json({ message: "Insufficient balance" });
    }

    await connection.execute("UPDATE users SET balance = balance - ? WHERE id = ?", [amount, req.user.id]);
    await connection.execute(
      "INSERT INTO withdrawals (user_id, amount, method, account_details, status) VALUES (?, ?, ?, ?, 'Pending')",
      [req.user.id, amount, method, accountDetails]
    );

    await connection.commit();
    res.json({ message: "Withdrawal request submitted successfully!" });
  } catch (error) {
    if (connection) await connection.rollback();
    res.status(500).json({ message: "Withdrawal failed" });
  } finally {
    if (connection) connection.release();
  }
});

// --- 4. ADMIN ROUTES ---
app.get("/admin/withdrawals", authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT w.*, u.name, u.email 
      FROM withdrawals w 
      JOIN users u ON w.user_id = u.id 
      ORDER BY w.id DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: "Admin fetch failed" });
  }
});

app.post("/admin/update-withdrawal", authenticateToken, isAdmin, async (req, res) => {
  const { id, status } = req.body;
  try {
    await db.execute("UPDATE withdrawals SET status = ? WHERE id = ?", [status, id]);
    res.json({ success: true, message: "Withdrawal status updated" });
  } catch (error) {
    res.status(500).json({ message: "Update failed" });
  }
});

app.get("/admin/users", authenticateToken, isAdmin, async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT id, name, email, balance, role, is_active FROM users ORDER BY id DESC");
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: "User list failed" });
  }
});

app.post("/admin/update-user-balance", authenticateToken, isAdmin, async (req, res) => {
  const { id, balance } = req.body;
  try {
    await db.execute("UPDATE users SET balance = ? WHERE id = ?", [balance, id]);
    res.json({ success: true, message: "Balance updated by Admin" });
  } catch (error) {
    res.status(500).json({ message: "Balance update failed" });
  }
});

app.post("/admin/toggle-user-status", authenticateToken, isAdmin, async (req, res) => {
  const { id, is_active } = req.body;
  try {
    await db.execute("UPDATE users SET is_active = ? WHERE id = ?", [is_active, id]);
    res.json({ success: true, message: is_active ? "User Unblocked" : "User Blocked" });
  } catch (error) {
    res.status(500).json({ message: "Status toggle failed" });
  }
});

// Vercel export (Serverless function ke liye)
module.exports = app;
