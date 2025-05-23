// import dotenv from 'dotenv';
// dotenv.config();
// Load environment variables FIRST
import dotenv from 'dotenv';
dotenv.config({ path: './.env' }); // Explicitly specify the path
import express from 'express';
import { google } from 'googleapis';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import emailService from './emailService.js';
import { createRequire } from 'module'; // For emailService.js which still uses require

const require = createRequire(import.meta.url);

const app = express();



// Security Middleware
app.use(helmet());
app.use(cookieParser());

// CORS Configuration
const corsOptions = {
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  exposedHeaders: ['X-User-Email']
};
app.use(cors(corsOptions));

app.use(express.json());

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// MongoDB Connection
const uri = process.env.MONGODB_URI || 'mongodb+srv://brokertest:WuseNGm9pxOqcCL8@cluster0.zpeipot.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected successfully 🚀'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Schemas
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String, required: true },
  currency: { type: String, required: true, default: 'USD' },
  country: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  refreshTokens: [String] // Store refresh tokens for invalidation
});

const DepositSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true },
  cryptoAmount: { type: Number },
  cryptoCurrency: { type: String },
  walletAddress: { type: String },
  transactionHash: { type: String },
  status: { 
    type: String, 
    enum: ['pending', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  depositMethod: { type: String },
  bonusApplied: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const UserWalletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  totalBalance: { type: Number, default: 0, min: 0 },
  availableBalance: { type: Number, default: 0, min: 0 },
  totalProfit: { type: Number, default: 0 },
  totalDeposits: { type: Number, default: 0 },
  totalWithdrawals: { type: Number, default: 0 },
  bonuses: {
    welcomeBonus: {
      amount: { type: Number, default: 50 },
      claimed: { type: Boolean, default: false },
      claimDate: Date
    },
    referralBonus: {
      amount: { type: Number, default: 0 },
      referrals: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        amount: Number,
        date: { type: Date, default: Date.now }
      }]
    },
    depositBonuses: [{
      amount: Number,
      depositId: { type: mongoose.Schema.Types.ObjectId, ref: 'Deposit' },
      date: { type: Date, default: Date.now },
      expiryDate: Date
    }]
  },
  currency: { type: String, default: 'USD' },
  lastUpdated: { type: Date, default: Date.now }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});


// Add this with your other schemas
const WithdrawalSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true },
  walletAddress: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  transactionHash: { type: String },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Add this with your other models
const Withdrawal = mongoose.model('Withdrawal', WithdrawalSchema);


// Indexes
UserWalletSchema.index({ 'bonuses.welcomeBonus.claimed': 1 });

// Virtuals
UserWalletSchema.virtual('totalBonuses').get(function() {
  return this.bonuses.welcomeBonus.amount + 
         this.bonuses.referralBonus.amount +
         this.bonuses.depositBonuses.reduce((sum, bonus) => sum + bonus.amount, 0);
});

// Hooks
UserWalletSchema.pre('save', function(next) {
  this.availableBalance = this.totalBalance + this.totalBonuses;
  this.lastUpdated = new Date();
  next();
});

UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  try {
    this.password = await bcrypt.hash(this.password, 12);
    next();
  } catch (error) {
    next(error);
  }
});

UserSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Models
const User = mongoose.model('User', UserSchema);
const Deposit = mongoose.model('Deposit', DepositSchema);
const UserWallet = mongoose.model('UserWallet', UserWalletSchema);




async function authenticateToken(req, res, next) {
  try {
    // Get token from Authorization header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    // Get email from headers
    const userEmail = req.headers['email'];
    
    if (!token) {
      return res.status(401).json({ 
        message: 'Authorization token required',
        code: 'TOKEN_MISSING'
      });
    }
    
    if (!userEmail) {
      return res.status(401).json({ 
        message: 'User email required',
        code: 'EMAIL_MISSING'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Find user
    const user = await User.findOne({ 
      _id: decoded.userId, 
      email: userEmail 
    }).select('+refreshTokens');

    if (!user) {
      return res.status(403).json({ 
        message: 'Invalid credentials',
        code: 'INVALID_CREDENTIALS'
      });
    }

    // Check if token is in refreshTokens (optional)
    // This adds an extra layer of security
    if (!user.refreshTokens.some(t => {
      try {
        const rt = jwt.verify(t, process.env.JWT_REFRESH_SECRET);
        return rt.userId === decoded.userId;
      } catch {
        return false;
      }
    })) {
      return res.status(403).json({ 
        message: 'Token invalidated',
        code: 'TOKEN_INVALIDATED'
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        message: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(403).json({ 
        message: 'Invalid token',
        code: 'INVALID_TOKEN'
      });
    }
    
    res.status(500).json({ 
      message: 'Authentication failed',
      code: 'AUTH_FAILED'
    });
  }
}


// Add this before your routes
if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
  throw new Error('JWT secrets must be defined in environment variables');
}



// Configure OAuth2 client
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oAuth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});


// This should be before your routes
app.use(express.json());




// ... your routes go here
// Routes
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, phone, currency, country } = req.body;

    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email already in use' });
    }

    const newUser = new User({ name, email, password, phone, currency, country });
    await newUser.save();
    await emailService.sendWelcomeEmail(newUser);

    const newWallet = new UserWallet({ 
      userId: newUser._id,
      bonuses: { welcomeBonus: { amount: 50 } }
    });
    await newWallet.save();

    // Generate tokens
    const token = jwt.sign(
      { userId: newUser._id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
    );

    const refreshToken = jwt.sign(
      { userId: newUser._id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
    );

    // Store refresh token
    newUser.refreshTokens.push(refreshToken);
    await newUser.save();

    res.status(201).json({ 
      token,
      refreshToken,
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid password' });
    }

    // Generate tokens
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
    );

    const refreshToken = jwt.sign(
      { userId: user._id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
    );

    // Store refresh token
    user.refreshTokens.push(refreshToken);
    await user.save();

    res.status(200).json({ 
      token,
      refreshToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Login failed' });
  }
});

app.post('/api/refresh-token', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const userEmail = req.headers['email'];
    
    if (!refreshToken || !userEmail) {
      return res.status(400).json({ message: 'Refresh token and email required' });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findOne({ 
      _id: decoded.userId, 
      email: userEmail,
      refreshTokens: refreshToken
    });

    if (!user) {
      return res.status(403).json({ message: 'Invalid refresh token' });
    }

    // Generate new access token
    const newToken = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' }
    );

    res.json({ 
      token: newToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(401).json({ message: 'Invalid refresh token' });
  }
});

app.post('/api/logout', authenticateToken, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const user = req.user;

    // Remove the refresh token
    user.refreshTokens = user.refreshTokens.filter(token => token !== refreshToken);
    await user.save();

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ message: 'Logout failed' });
  }
});

// Protected Routes
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    res.json({
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      phone: req.user.phone,
      currency: req.user.currency,
      country: req.user.country
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ message: 'Error fetching profile' });
  }
});

app.get('/api/wallet', authenticateToken, async (req, res) => {
  try {
    let wallet = await UserWallet.findOne({ userId: req.user._id });
    if (!wallet) {
      wallet = new UserWallet({
        userId: req.user._id,
        availableBalance: 1850,
        bonuses: {
          welcomeBonus: {
            amount: 1850,
            claimed: false,
            claimDate: new Date()
          }
        }
      });
      await wallet.save();
    }

    res.json(wallet);
  } catch (error) {
    console.error('Wallet error:', error);
    res.status(500).json({ message: 'Error fetching wallet' });
  }
});

app.post('/api/deposit', authenticateToken, async (req, res) => {
  try {
    // First check if req.body exists at all
    if (!req.body) {
      return res.status(400).json({ message: 'Request body is missing' });
    }

    const { 
      amount, 
      currency, 
      cryptoAmount, 
      cryptoCurrency, 
      walletAddress 
    } = req.body;

    // Validate all required fields exist
    const missingFields = [];
    if (!amount) missingFields.push('amount');
    if (!currency) missingFields.push('currency');
    if (!cryptoAmount) missingFields.push('cryptoAmount');
    if (!cryptoCurrency) missingFields.push('cryptoCurrency');
    if (!walletAddress) missingFields.push('walletAddress');

    if (missingFields.length > 0) {
      return res.status(400).json({ 
        message: 'Missing required fields',
        missingFields 
      });
    }

    if (amount <= 0) {
      return res.status(400).json({ message: 'Amount must be positive' });
    }

    const newDeposit = new Deposit({
      userId: req.user._id,
      amount,
      currency,
      cryptoAmount,
      cryptoCurrency,
      walletAddress,
      status: 'pending'
    });

    const user = req.headers['email'];
    await newDeposit.save();
    await emailService.sendDepositConfirmation(user, newDeposit);


    res.status(201).json({
      message: 'Deposit initiated successfully',
      deposit: newDeposit
    });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ 
      message: 'Deposit failed',
      error: error.message 
    });
  }
});



app.post('/api/deposit/confirm', authenticateToken, async (req, res) => {
  try {
    const { depositId, transactionHash } = req.body;

    const deposit = await Deposit.findOne({
      _id: depositId,
      userId: req.user._id
    });

    if (!deposit) {
      return res.status(404).json({ message: 'Deposit not found' });
    }

    deposit.transactionHash = transactionHash;
    deposit.status = 'completed';
    await deposit.save();

    // Update wallet
    const wallet = await UserWallet.findOneAndUpdate(
      { userId: req.user._id },
      { 
        $inc: { 
          totalBalance: deposit.amount,
          totalDeposits: deposit.amount,
          availableBalance: deposit.amount 
        } 
      },
      { new: true, upsert: true }
    );

    res.json({ 
      message: 'Deposit confirmed',
      wallet,
      deposit
    });
  } catch (error) {
    console.error('Deposit confirmation error:', error);
    res.status(500).json({ message: 'Deposit confirmation failed' });
  }
});

app.get('/api/deposits', authenticateToken, async (req, res) => {
  try {
    const deposits = await Deposit.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(deposits);
  } catch (error) {
    console.error('Deposit history error:', error);
    res.status(500).json({ message: 'Error fetching deposit history' });
  }
});



// Add these routes after your deposit routes

// Create withdrawal
app.post('/api/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount, currency, walletAddress } = req.body;

    // Validate input
    if (!amount || !currency || !walletAddress) {
      return res.status(400).json({ 
        message: 'Amount, currency, and wallet address are required',
        code: 'MISSING_FIELDS'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({ 
        message: 'Amount must be positive',
        code: 'INVALID_AMOUNT'
      });
    }

    // Check user's wallet balance
    const wallet = await UserWallet.findOne({ userId: req.user._id });
    if (!wallet || wallet.availableBalance < amount) {
      return res.status(400).json({ 
        message: 'Insufficient funds',
        code: 'INSUFFICIENT_FUNDS'
      });
    }

    // Create withdrawal
    const withdrawal = new Withdrawal({
      userId: req.user._id,
      amount,
      currency,
      walletAddress,
      status: 'pending'
    });

    await withdrawal.save();

    // Update wallet (reserve the funds)
    wallet.availableBalance -= amount;
    await wallet.save();
    const user = await User.findById(req.user._id);
    await emailService.sendWithdrawalRequest(user, withdrawal);


    res.status(201).json({
      message: 'Withdrawal request submitted',
      withdrawal
    });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ 
      message: 'Withdrawal failed',
      error: error.message 
    });
  }
});

// Get withdrawal history
app.get('/api/withdrawals', authenticateToken, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json(withdrawals);
    console.log(withdrawals);
  } catch (error) {
    console.error('Withdrawal history error:', error);
    res.status(500).json({ 
      message: 'Error fetching withdrawal history',
      error: error.message 
    });
  }
});



// Error Handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));