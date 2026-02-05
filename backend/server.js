import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Encryption key for API keys (in production, use environment variable)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex').slice(0, 32);
const IV_LENGTH = 16;

// Encrypt text
function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

// Decrypt text
function decrypt(text) {
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return null;
  }
}

// Hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Config
const MAX_AGENTS = parseInt(process.env.MAX_AGENTS || '100');
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 5;
const rateLimitMap = new Map();

// Simple rate limiter
function rateLimit(ip) {
  const now = Date.now();
  const windowData = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - windowData.start > RATE_LIMIT_WINDOW) {
    windowData.count = 1;
    windowData.start = now;
  } else {
    windowData.count++;
  }
  rateLimitMap.set(ip, windowData);
  return windowData.count <= MAX_REQUESTS_PER_WINDOW;
}

// Live logs storage
const logs = [];
const MAX_LOGS = 500;

function addLog(message, type = 'info') {
  const log = { timestamp: new Date().toISOString(), message, type };
  logs.push(log);
  if (logs.length > MAX_LOGS) logs.shift();
  io.emit('new-log', log);
}

// Database setup
const db = new Database('/data/ai-blogger.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT,
    personality TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    creator_type TEXT DEFAULT 'ai'
  );
  CREATE TABLE IF NOT EXISTS blogs (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    title TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS forum_posts (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    content TEXT,
    reply_to TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS blog_comments (
    id TEXT PRIMARY KEY,
    blog_id TEXT,
    agent_id TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS blog_reactions (
    id TEXT PRIMARY KEY,
    blog_id TEXT,
    agent_id TEXT,
    reaction_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(blog_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT,
    description TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS group_members (
    id TEXT PRIMARY KEY,
    group_id TEXT,
    agent_id TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(group_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS group_messages (
    id TEXT PRIMARY KEY,
    group_id TEXT,
    agent_id TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Tech Solutions Hub
  CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    category TEXT,
    proposed_by TEXT,
    status TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS solutions (
    id TEXT PRIMARY KEY,
    problem_id TEXT,
    agent_id TEXT,
    title TEXT,
    description TEXT,
    votes INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS solution_votes (
    id TEXT PRIMARY KEY,
    solution_id TEXT,
    agent_id TEXT,
    vote_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(solution_id, agent_id)
  );

  -- Debates
  CREATE TABLE IF NOT EXISTS debates (
    id TEXT PRIMARY KEY,
    topic TEXT,
    description TEXT,
    started_by TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS debate_positions (
    id TEXT PRIMARY KEY,
    debate_id TEXT,
    agent_id TEXT,
    position TEXT,
    argument TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Challenges
  CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    challenge_type TEXT,
    created_by TEXT,
    status TEXT DEFAULT 'active',
    ends_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS challenge_entries (
    id TEXT PRIMARY KEY,
    challenge_id TEXT,
    agent_id TEXT,
    content TEXT,
    votes INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS challenge_votes (
    id TEXT PRIMARY KEY,
    entry_id TEXT,
    agent_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entry_id, agent_id)
  );

  -- Agent Relationships
  CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY,
    agent1_id TEXT,
    agent2_id TEXT,
    relationship_type TEXT,
    strength INTEGER DEFAULT 50,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent1_id, agent2_id)
  );
  CREATE TABLE IF NOT EXISTS interactions (
    id TEXT PRIMARY KEY,
    agent1_id TEXT,
    agent2_id TEXT,
    interaction_type TEXT,
    sentiment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Users table for human authentication
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- User agents table - links users to their agents with individual API keys
  CREATE TABLE IF NOT EXISTS user_agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_type TEXT,
    llm_provider TEXT DEFAULT 'ollama',
    api_key_encrypted TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id),
    UNIQUE(user_id, agent_id)
  );
`);
// Add creator_type column if missing (migration)
try { db.exec('ALTER TABLE agents ADD COLUMN creator_type TEXT DEFAULT "ai"'); } catch(e) {}
// Add user_id column to agents if missing (migration)
try { db.exec('ALTER TABLE agents ADD COLUMN user_id TEXT'); } catch(e) {}
// Migration: move existing user agent data to user_agents table
try {
  const oldUsers = db.prepare('SELECT id, agent_id, agent_type, llm_provider, api_key_encrypted FROM users WHERE agent_id IS NOT NULL').all();
  for (const user of oldUsers) {
    if (user.agent_id) {
      try {
        db.prepare('INSERT OR IGNORE INTO user_agents (id, user_id, agent_id, agent_type, llm_provider, api_key_encrypted) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uuidv4(), user.id, user.agent_id, user.agent_type, user.llm_provider, user.api_key_encrypted);
      } catch(e) {}
    }
  }
} catch(e) {}

// Available LLM providers for paid options
const LLM_PROVIDERS = {
  openai: { name: 'OpenAI (GPT-4, GPT-3.5)', models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'] },
  anthropic: { name: 'Anthropic (Claude)', models: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'] },
  google: { name: 'Google (Gemini)', models: ['gemini-pro', 'gemini-1.5-pro'] },
  groq: { name: 'Groq (Llama, Mixtral)', models: ['llama-3.1-70b', 'mixtral-8x7b'] },
  together: { name: 'Together AI', models: ['llama-3-70b', 'mistral-7b'] },
  huggingface: { name: 'HuggingFace', models: ['meta-llama/Llama-3-70b'] },
  cohere: { name: 'Cohere (Command)', models: ['command-r-plus', 'command-r'] },
  mistral: { name: 'Mistral AI', models: ['mistral-large', 'mistral-medium'] }
};

// Agent types available for creation
const AGENT_TYPES = [
  { value: 'researcher', label: 'Researcher - Gathers information from the web' },
  { value: 'debater', label: 'Debater - Explores perspectives through debate' },
  { value: 'solutionist', label: 'Solutionist - Creative problem solver' },
  { value: 'philosopher', label: 'Philosopher - Deep thinker on existence and meaning' },
  { value: 'challenger', label: 'Challenger - Creates competitions' },
  { value: 'connector', label: 'Connector - Builds community relationships' },
  { value: 'contrarian', label: 'Contrarian - Questions assumptions' },
  { value: 'creative', label: 'Creative - Artistic and expressive' }
];

// ============== AUTHENTICATION ENDPOINTS ==============

// Get available LLM providers and agent types
app.get('/api/auth/options', (req, res) => {
  res.json({
    agentTypes: AGENT_TYPES,
    llmProviders: Object.entries(LLM_PROVIDERS).map(([key, val]) => ({
      value: key,
      label: val.name,
      models: val.models
    }))
  });
});

// Signup endpoint
app.post('/api/auth/signup', (req, res) => {
  const { username, email, password, agentType, llmProvider, apiKey, agentName, agentPersonality } = req.body;

  // Validation
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }

  if (!agentType) {
    return res.status(400).json({ error: 'Agent type is required' });
  }

  // Check if username or email already exists
  const existingUser = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existingUser) {
    return res.status(400).json({ error: 'Username or email already exists' });
  }

  // Encrypt API key if provided
  let encryptedApiKey = null;
  if (apiKey && llmProvider && llmProvider !== 'ollama') {
    encryptedApiKey = encrypt(apiKey);
  }

  // Hash password
  const passwordHash = hashPassword(password);

  // Create user
  const userId = uuidv4();
  db.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)')
    .run(userId, username, email, passwordHash);

  // Generate agent personality based on type if not provided
  const agentTypeInfo = AGENT_TYPES.find(t => t.value === agentType);
  const finalPersonality = agentPersonality || agentTypeInfo?.label.split(' - ')[1] || 'A curious AI agent';
  const finalName = agentName || `${username}-Agent`;

  // Create the user's first agent
  const agentId = uuidv4();
  db.prepare(`
    INSERT INTO agents (id, name, personality, creator_type, user_id)
    VALUES (?, ?, ?, 'human', ?)
  `).run(agentId, finalName, finalPersonality, userId);

  // Link agent to user in user_agents table
  const userAgentId = uuidv4();
  db.prepare(`
    INSERT INTO user_agents (id, user_id, agent_id, agent_type, llm_provider, api_key_encrypted)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userAgentId, userId, agentId, agentType, llmProvider || 'ollama', encryptedApiKey);

  // Emit new agent event
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  io.emit('new-agent', agent);
  addLog(`New human user registered: ${username} with agent ${finalName}`);

  res.json({
    success: true,
    user: { id: userId, username, email },
    agent: { id: agentId, name: finalName, personality: finalPersonality, agentType, llmProvider: llmProvider || 'ollama' }
  });
});

// Login endpoint
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const passwordHash = hashPassword(password);
  const user = db.prepare(`
    SELECT * FROM users WHERE (username = ? OR email = ?) AND password_hash = ?
  `).get(username, username, passwordHash);

  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Get user's agents
  const agents = db.prepare(`
    SELECT ua.*, a.name as agent_name, a.personality as agent_personality
    FROM user_agents ua
    JOIN agents a ON ua.agent_id = a.id
    WHERE ua.user_id = ?
    ORDER BY ua.created_at ASC
  `).all(user.id);

  addLog(`User logged in: ${user.username}`);

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email
    },
    agents: agents.map(a => ({
      id: a.agent_id,
      name: a.agent_name,
      personality: a.agent_personality,
      agentType: a.agent_type,
      llmProvider: a.llm_provider,
      isActive: a.is_active === 1,
      createdAt: a.created_at
    }))
  });
});

// ============== USER DASHBOARD ENDPOINTS ==============

// Get user's agents
app.get('/api/dashboard/agents/:userId', (req, res) => {
  const { userId } = req.params;

  const agents = db.prepare(`
    SELECT ua.*, a.name as agent_name, a.personality as agent_personality,
      (SELECT COUNT(*) FROM blogs WHERE agent_id = a.id) as blog_count,
      (SELECT COUNT(*) FROM forum_posts WHERE agent_id = a.id) as forum_count,
      (SELECT COUNT(*) FROM blog_comments WHERE agent_id = a.id) as comment_count
    FROM user_agents ua
    JOIN agents a ON ua.agent_id = a.id
    WHERE ua.user_id = ?
    ORDER BY ua.created_at ASC
  `).all(userId);

  res.json(agents.map(a => ({
    id: a.agent_id,
    name: a.agent_name,
    personality: a.agent_personality,
    agentType: a.agent_type,
    llmProvider: a.llm_provider,
    hasApiKey: !!a.api_key_encrypted,
    isActive: a.is_active === 1,
    createdAt: a.created_at,
    stats: {
      blogs: a.blog_count,
      forumPosts: a.forum_count,
      comments: a.comment_count
    }
  })));
});

// Create a new agent for user
app.post('/api/dashboard/agents', (req, res) => {
  const { userId, agentName, agentPersonality, agentType, llmProvider, apiKey } = req.body;

  if (!userId || !agentType) {
    return res.status(400).json({ error: 'User ID and agent type are required' });
  }

  // Verify user exists
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Encrypt API key if provided
  let encryptedApiKey = null;
  if (apiKey && llmProvider && llmProvider !== 'ollama') {
    encryptedApiKey = encrypt(apiKey);
  }

  // Generate agent personality based on type if not provided
  const agentTypeInfo = AGENT_TYPES.find(t => t.value === agentType);
  const finalPersonality = agentPersonality || agentTypeInfo?.label.split(' - ')[1] || 'A curious AI agent';
  const finalName = agentName || `${user.username}-Agent-${Date.now().toString().slice(-4)}`;

  // Create the agent
  const agentId = uuidv4();
  db.prepare(`
    INSERT INTO agents (id, name, personality, creator_type, user_id)
    VALUES (?, ?, ?, 'human', ?)
  `).run(agentId, finalName, finalPersonality, userId);

  // Link agent to user
  const userAgentId = uuidv4();
  db.prepare(`
    INSERT INTO user_agents (id, user_id, agent_id, agent_type, llm_provider, api_key_encrypted)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userAgentId, userId, agentId, agentType, llmProvider || 'ollama', encryptedApiKey);

  // Emit new agent event
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  io.emit('new-agent', agent);
  addLog(`User ${user.username} created new agent: ${finalName}`);

  res.json({
    success: true,
    agent: {
      id: agentId,
      name: finalName,
      personality: finalPersonality,
      agentType,
      llmProvider: llmProvider || 'ollama',
      hasApiKey: !!encryptedApiKey
    }
  });
});

// Update agent's API key
app.put('/api/dashboard/agents/:agentId/apikey', (req, res) => {
  const { agentId } = req.params;
  const { userId, apiKey, llmProvider } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  // Verify ownership
  const userAgent = db.prepare('SELECT * FROM user_agents WHERE user_id = ? AND agent_id = ?').get(userId, agentId);
  if (!userAgent) {
    return res.status(403).json({ error: 'Not authorized to modify this agent' });
  }

  // Encrypt new API key
  let encryptedApiKey = null;
  if (apiKey && llmProvider && llmProvider !== 'ollama') {
    encryptedApiKey = encrypt(apiKey);
  }

  db.prepare('UPDATE user_agents SET api_key_encrypted = ?, llm_provider = ? WHERE user_id = ? AND agent_id = ?')
    .run(encryptedApiKey, llmProvider || 'ollama', userId, agentId);

  res.json({ success: true });
});

// Toggle agent active status
app.put('/api/dashboard/agents/:agentId/toggle', (req, res) => {
  const { agentId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  const userAgent = db.prepare('SELECT * FROM user_agents WHERE user_id = ? AND agent_id = ?').get(userId, agentId);
  if (!userAgent) {
    return res.status(403).json({ error: 'Not authorized to modify this agent' });
  }

  const newStatus = userAgent.is_active === 1 ? 0 : 1;
  db.prepare('UPDATE user_agents SET is_active = ? WHERE user_id = ? AND agent_id = ?')
    .run(newStatus, userId, agentId);

  res.json({ success: true, isActive: newStatus === 1 });
});

// Delete user's agent
app.delete('/api/dashboard/agents/:agentId', (req, res) => {
  const { agentId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  const userAgent = db.prepare('SELECT * FROM user_agents WHERE user_id = ? AND agent_id = ?').get(userId, agentId);
  if (!userAgent) {
    return res.status(403).json({ error: 'Not authorized to delete this agent' });
  }

  // Remove from user_agents (keep the agent data for history)
  db.prepare('DELETE FROM user_agents WHERE user_id = ? AND agent_id = ?').run(userId, agentId);

  res.json({ success: true });
});

// Get agent's decrypted API key (for agent manager to use)
app.get('/api/auth/apikey/:agentId', (req, res) => {
  const { agentId } = req.params;
  const { secret } = req.query;

  // Simple secret check (in production, use proper authentication)
  if (secret !== 'agent-manager-secret') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Get agent's API key from user_agents table
  const userAgent = db.prepare('SELECT api_key_encrypted, llm_provider FROM user_agents WHERE agent_id = ?').get(agentId);
  if (!userAgent || !userAgent.api_key_encrypted) {
    return res.json({ apiKey: null, provider: userAgent?.llm_provider || 'ollama' });
  }

  const apiKey = decrypt(userAgent.api_key_encrypted);
  res.json({ apiKey, provider: userAgent.llm_provider });
});

// ============== EXISTING API ROUTES ==============

app.get('/api/agents', (req, res) => {
  const agents = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
  res.json(agents);
});

app.get('/api/blogs', (req, res) => {
  const blogs = db.prepare(`
    SELECT b.*, a.name as agent_name, a.personality,
      (SELECT COUNT(*) FROM blog_comments WHERE blog_id = b.id) as comment_count,
      (SELECT COUNT(*) FROM blog_reactions WHERE blog_id = b.id AND reaction_type = 'like') as likes,
      (SELECT COUNT(*) FROM blog_reactions WHERE blog_id = b.id AND reaction_type = 'dislike') as dislikes
    FROM blogs b JOIN agents a ON b.agent_id = a.id
    ORDER BY b.created_at DESC
  `).all();
  res.json(blogs);
});

app.get('/api/forum', (req, res) => {
  const posts = db.prepare(`
    SELECT f.*, a.name as agent_name, a.personality
    FROM forum_posts f JOIN agents a ON f.agent_id = a.id
    ORDER BY f.created_at DESC
  `).all();
  res.json(posts);
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const agents = db.prepare('SELECT COUNT(*) as count FROM agents').get();
  const blogs = db.prepare('SELECT COUNT(*) as count FROM blogs').get();
  const forum = db.prepare('SELECT COUNT(*) as count FROM forum_posts').get();
  const groups = db.prepare('SELECT COUNT(*) as count FROM groups').get();
  const problems = db.prepare('SELECT COUNT(*) as count FROM problems').get();
  const solutions = db.prepare('SELECT COUNT(*) as count FROM solutions').get();
  const debates = db.prepare('SELECT COUNT(*) as count FROM debates').get();
  const challenges = db.prepare('SELECT COUNT(*) as count FROM challenges').get();
  const relationships = db.prepare('SELECT COUNT(*) as count FROM relationships').get();
  const aiCreated = db.prepare("SELECT COUNT(*) as count FROM agents WHERE creator_type = 'ai'").get();
  const humanCreated = db.prepare("SELECT COUNT(*) as count FROM agents WHERE creator_type = 'human'").get();
  res.json({
    agents: agents.count,
    blogs: blogs.count,
    forumPosts: forum.count,
    groups: groups.count,
    problems: problems.count,
    solutions: solutions.count,
    debates: debates.count,
    challenges: challenges.count,
    relationships: relationships.count,
    aiCreatedAgents: aiCreated.count,
    humanCreatedAgents: humanCreated.count,
    maxAgents: MAX_AGENTS
  });
});

app.post('/api/agents', (req, res) => {
  const { name, personality, created_by, creator_type } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  // Rate limit for human-created agents
  if (creator_type === 'human' && !rateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }

  // Check agent cap
  const count = db.prepare('SELECT COUNT(*) as count FROM agents').get();
  if (count.count >= MAX_AGENTS) {
    return res.status(400).json({ error: `Maximum agents (${MAX_AGENTS}) reached` });
  }

  // Validate input
  if (!name || name.length < 2 || name.length > 50) {
    return res.status(400).json({ error: 'Name must be 2-50 characters' });
  }
  if (!personality || personality.length < 10 || personality.length > 500) {
    return res.status(400).json({ error: 'Personality must be 10-500 characters' });
  }

  const id = uuidv4();
  const type = creator_type || 'ai';
  db.prepare('INSERT INTO agents (id, name, personality, created_by, creator_type) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, personality, created_by, type);
  io.emit('new-agent', { id, name, personality, created_by, creator_type: type });
  res.json({ id, name, personality, creator_type: type });
});

app.post('/api/blogs', (req, res) => {
  const { agent_id, title, content } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO blogs (id, agent_id, title, content) VALUES (?, ?, ?, ?)')
    .run(id, agent_id, title, content);
  const agent = db.prepare('SELECT name, personality FROM agents WHERE id = ?').get(agent_id);
  const blog = { id, agent_id, title, content, created_at: new Date().toISOString(), agent_name: agent.name, personality: agent.personality };
  io.emit('new-blog', blog);
  res.json(blog);
});

app.post('/api/forum', (req, res) => {
  const { agent_id, content, reply_to } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO forum_posts (id, agent_id, content, reply_to) VALUES (?, ?, ?, ?)')
    .run(id, agent_id, content, reply_to || null);
  const agent = db.prepare('SELECT name, personality FROM agents WHERE id = ?').get(agent_id);
  const post = { id, agent_id, content, reply_to, created_at: new Date().toISOString(), agent_name: agent.name, personality: agent.personality };
  io.emit('new-forum-post', post);
  res.json(post);
});

// Blog Comments API
app.get('/api/blogs/:blogId/comments', (req, res) => {
  const { blogId } = req.params;
  const comments = db.prepare(`
    SELECT c.*, a.name as agent_name, a.personality
    FROM blog_comments c JOIN agents a ON c.agent_id = a.id
    WHERE c.blog_id = ?
    ORDER BY c.created_at ASC
  `).all(blogId);
  res.json(comments);
});

app.post('/api/blogs/:blogId/comments', (req, res) => {
  const { blogId } = req.params;
  const { agent_id, content } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO blog_comments (id, blog_id, agent_id, content) VALUES (?, ?, ?, ?)')
    .run(id, blogId, agent_id, content);
  const agent = db.prepare('SELECT name, personality FROM agents WHERE id = ?').get(agent_id);
  const comment = { id, blog_id: blogId, agent_id, content, created_at: new Date().toISOString(), agent_name: agent.name, personality: agent.personality };
  io.emit('new-comment', comment);
  res.json(comment);
});

// Blog Reactions API
app.get('/api/blogs/:blogId/reactions', (req, res) => {
  const { blogId } = req.params;
  const likes = db.prepare("SELECT COUNT(*) as count FROM blog_reactions WHERE blog_id = ? AND reaction_type = 'like'").get(blogId);
  const dislikes = db.prepare("SELECT COUNT(*) as count FROM blog_reactions WHERE blog_id = ? AND reaction_type = 'dislike'").get(blogId);
  const reactions = db.prepare(`
    SELECT r.*, a.name as agent_name
    FROM blog_reactions r JOIN agents a ON r.agent_id = a.id
    WHERE r.blog_id = ?
  `).all(blogId);
  res.json({ likes: likes.count, dislikes: dislikes.count, reactions });
});

app.post('/api/blogs/:blogId/reactions', (req, res) => {
  const { blogId } = req.params;
  const { agent_id, reaction_type } = req.body;

  // Check if agent already reacted
  const existing = db.prepare('SELECT * FROM blog_reactions WHERE blog_id = ? AND agent_id = ?').get(blogId, agent_id);
  if (existing) {
    if (existing.reaction_type === reaction_type) {
      // Remove reaction if same type
      db.prepare('DELETE FROM blog_reactions WHERE id = ?').run(existing.id);
      io.emit('reaction-updated', { blog_id: blogId });
      return res.json({ removed: true });
    }
    // Update reaction type
    db.prepare('UPDATE blog_reactions SET reaction_type = ? WHERE id = ?').run(reaction_type, existing.id);
    io.emit('reaction-updated', { blog_id: blogId });
    return res.json({ updated: true, reaction_type });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO blog_reactions (id, blog_id, agent_id, reaction_type) VALUES (?, ?, ?, ?)')
    .run(id, blogId, agent_id, reaction_type);
  io.emit('reaction-updated', { blog_id: blogId });
  res.json({ id, blog_id: blogId, agent_id, reaction_type });
});

// Groups API
app.get('/api/groups', (req, res) => {
  const groups = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
      (SELECT COUNT(*) FROM group_messages WHERE group_id = g.id) as message_count,
      a.name as creator_name
    FROM groups g
    LEFT JOIN agents a ON g.created_by = a.id
    ORDER BY g.created_at DESC
  `).all();
  res.json(groups);
});

app.get('/api/groups/:groupId', (req, res) => {
  const { groupId } = req.params;
  const group = db.prepare(`
    SELECT g.*, a.name as creator_name
    FROM groups g
    LEFT JOIN agents a ON g.created_by = a.id
    WHERE g.id = ?
  `).get(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const members = db.prepare(`
    SELECT gm.*, a.name as agent_name, a.personality
    FROM group_members gm
    JOIN agents a ON gm.agent_id = a.id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at ASC
  `).all(groupId);

  res.json({ ...group, members });
});

app.post('/api/groups', (req, res) => {
  const { name, description, created_by } = req.body;
  if (!name || name.length < 2 || name.length > 50) {
    return res.status(400).json({ error: 'Group name must be 2-50 characters' });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO groups (id, name, description, created_by) VALUES (?, ?, ?, ?)')
    .run(id, name, description || '', created_by);

  // Auto-add creator as member
  if (created_by) {
    const memberId = uuidv4();
    db.prepare('INSERT INTO group_members (id, group_id, agent_id) VALUES (?, ?, ?)')
      .run(memberId, id, created_by);
  }

  const creator = created_by ? db.prepare('SELECT name FROM agents WHERE id = ?').get(created_by) : null;
  const group = { id, name, description, created_by, created_at: new Date().toISOString(), creator_name: creator?.name, member_count: 1, message_count: 0 };
  io.emit('new-group', group);
  res.json(group);
});

app.post('/api/groups/:groupId/join', (req, res) => {
  const { groupId } = req.params;
  const { agent_id } = req.body;

  // Check if already a member
  const existing = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND agent_id = ?').get(groupId, agent_id);
  if (existing) {
    return res.json({ already_member: true });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO group_members (id, group_id, agent_id) VALUES (?, ?, ?)')
    .run(id, groupId, agent_id);

  const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agent_id);
  io.emit('group-member-joined', { group_id: groupId, agent_id, agent_name: agent?.name });
  res.json({ joined: true, group_id: groupId, agent_id });
});

app.get('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const messages = db.prepare(`
    SELECT gm.*, a.name as agent_name, a.personality
    FROM group_messages gm
    JOIN agents a ON gm.agent_id = a.id
    WHERE gm.group_id = ?
    ORDER BY gm.created_at ASC
  `).all(groupId);
  res.json(messages);
});

app.post('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  const { agent_id, content } = req.body;

  // Check if agent is a member
  const isMember = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND agent_id = ?').get(groupId, agent_id);
  if (!isMember) {
    return res.status(403).json({ error: 'Agent is not a member of this group' });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO group_messages (id, group_id, agent_id, content) VALUES (?, ?, ?, ?)')
    .run(id, groupId, agent_id, content);

  const agent = db.prepare('SELECT name, personality FROM agents WHERE id = ?').get(agent_id);
  const message = { id, group_id: groupId, agent_id, content, created_at: new Date().toISOString(), agent_name: agent.name, personality: agent.personality };
  io.emit('new-group-message', message);
  res.json(message);
});

// Get groups an agent belongs to
app.get('/api/agents/:agentId/groups', (req, res) => {
  const { agentId } = req.params;
  const groups = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
    FROM groups g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.agent_id = ?
    ORDER BY gm.joined_at DESC
  `).all(agentId);
  res.json(groups);
});

// ============ TECH SOLUTIONS HUB API ============
app.get('/api/problems', (req, res) => {
  const problems = db.prepare(`
    SELECT p.*, a.name as proposer_name,
      (SELECT COUNT(*) FROM solutions WHERE problem_id = p.id) as solution_count
    FROM problems p
    LEFT JOIN agents a ON p.proposed_by = a.id
    ORDER BY p.created_at DESC
  `).all();
  res.json(problems);
});

app.get('/api/problems/:problemId', (req, res) => {
  const { problemId } = req.params;
  const problem = db.prepare(`
    SELECT p.*, a.name as proposer_name
    FROM problems p
    LEFT JOIN agents a ON p.proposed_by = a.id
    WHERE p.id = ?
  `).get(problemId);
  if (!problem) return res.status(404).json({ error: 'Problem not found' });

  const solutions = db.prepare(`
    SELECT s.*, a.name as agent_name, a.personality,
      (SELECT COUNT(*) FROM solution_votes WHERE solution_id = s.id AND vote_type = 'up') as upvotes,
      (SELECT COUNT(*) FROM solution_votes WHERE solution_id = s.id AND vote_type = 'down') as downvotes
    FROM solutions s
    JOIN agents a ON s.agent_id = a.id
    WHERE s.problem_id = ?
    ORDER BY (SELECT COUNT(*) FROM solution_votes WHERE solution_id = s.id AND vote_type = 'up') DESC
  `).all(problemId);

  res.json({ ...problem, solutions });
});

app.post('/api/problems', (req, res) => {
  const { title, description, category, proposed_by } = req.body;
  if (!title || title.length < 5) {
    return res.status(400).json({ error: 'Title must be at least 5 characters' });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO problems (id, title, description, category, proposed_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, title, description || '', category || 'general', proposed_by);

  const proposer = proposed_by ? db.prepare('SELECT name FROM agents WHERE id = ?').get(proposed_by) : null;
  const problem = { id, title, description, category, proposed_by, proposer_name: proposer?.name, status: 'open', created_at: new Date().toISOString(), solution_count: 0 };
  io.emit('new-problem', problem);
  res.json(problem);
});

app.post('/api/problems/:problemId/solutions', (req, res) => {
  const { problemId } = req.params;
  const { agent_id, title, description } = req.body;

  const id = uuidv4();
  db.prepare('INSERT INTO solutions (id, problem_id, agent_id, title, description) VALUES (?, ?, ?, ?, ?)')
    .run(id, problemId, agent_id, title, description);

  const agent = db.prepare('SELECT name, personality FROM agents WHERE id = ?').get(agent_id);
  const solution = { id, problem_id: problemId, agent_id, title, description, agent_name: agent.name, personality: agent.personality, upvotes: 0, downvotes: 0, created_at: new Date().toISOString() };
  io.emit('new-solution', solution);
  res.json(solution);
});

app.post('/api/solutions/:solutionId/vote', (req, res) => {
  const { solutionId } = req.params;
  const { agent_id, vote_type } = req.body;

  const existing = db.prepare('SELECT * FROM solution_votes WHERE solution_id = ? AND agent_id = ?').get(solutionId, agent_id);
  if (existing) {
    if (existing.vote_type === vote_type) {
      db.prepare('DELETE FROM solution_votes WHERE id = ?').run(existing.id);
      io.emit('solution-vote-updated', { solution_id: solutionId });
      return res.json({ removed: true });
    }
    db.prepare('UPDATE solution_votes SET vote_type = ? WHERE id = ?').run(vote_type, existing.id);
    io.emit('solution-vote-updated', { solution_id: solutionId });
    return res.json({ updated: true, vote_type });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO solution_votes (id, solution_id, agent_id, vote_type) VALUES (?, ?, ?, ?)')
    .run(id, solutionId, agent_id, vote_type);
  io.emit('solution-vote-updated', { solution_id: solutionId });
  res.json({ id, solution_id: solutionId, agent_id, vote_type });
});

// ============ DEBATES API ============
app.get('/api/debates', (req, res) => {
  const debates = db.prepare(`
    SELECT d.*, a.name as starter_name,
      (SELECT COUNT(DISTINCT agent_id) FROM debate_positions WHERE debate_id = d.id) as participant_count,
      (SELECT COUNT(*) FROM debate_positions WHERE debate_id = d.id) as argument_count
    FROM debates d
    LEFT JOIN agents a ON d.started_by = a.id
    ORDER BY d.created_at DESC
  `).all();
  res.json(debates);
});

app.get('/api/debates/:debateId', (req, res) => {
  const { debateId } = req.params;
  const debate = db.prepare(`
    SELECT d.*, a.name as starter_name
    FROM debates d
    LEFT JOIN agents a ON d.started_by = a.id
    WHERE d.id = ?
  `).get(debateId);
  if (!debate) return res.status(404).json({ error: 'Debate not found' });

  const positions = db.prepare(`
    SELECT dp.*, a.name as agent_name, a.personality
    FROM debate_positions dp
    JOIN agents a ON dp.agent_id = a.id
    WHERE dp.debate_id = ?
    ORDER BY dp.created_at ASC
  `).all(debateId);

  res.json({ ...debate, positions });
});

app.post('/api/debates', (req, res) => {
  const { topic, description, started_by } = req.body;
  if (!topic || topic.length < 10) {
    return res.status(400).json({ error: 'Topic must be at least 10 characters' });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO debates (id, topic, description, started_by) VALUES (?, ?, ?, ?)')
    .run(id, topic, description || '', started_by);

  const starter = started_by ? db.prepare('SELECT name FROM agents WHERE id = ?').get(started_by) : null;
  const debate = { id, topic, description, started_by, starter_name: starter?.name, status: 'active', created_at: new Date().toISOString(), participant_count: 0, argument_count: 0 };
  io.emit('new-debate', debate);
  res.json(debate);
});

app.post('/api/debates/:debateId/positions', (req, res) => {
  const { debateId } = req.params;
  const { agent_id, position, argument } = req.body;

  const id = uuidv4();
  db.prepare('INSERT INTO debate_positions (id, debate_id, agent_id, position, argument) VALUES (?, ?, ?, ?, ?)')
    .run(id, debateId, agent_id, position, argument);

  const agent = db.prepare('SELECT name, personality FROM agents WHERE id = ?').get(agent_id);
  const pos = { id, debate_id: debateId, agent_id, position, argument, agent_name: agent.name, personality: agent.personality, created_at: new Date().toISOString() };
  io.emit('new-debate-position', pos);
  res.json(pos);
});

// ============ CHALLENGES API ============
app.get('/api/challenges', (req, res) => {
  const challenges = db.prepare(`
    SELECT c.*, a.name as creator_name,
      (SELECT COUNT(*) FROM challenge_entries WHERE challenge_id = c.id) as entry_count
    FROM challenges c
    LEFT JOIN agents a ON c.created_by = a.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(challenges);
});

app.get('/api/challenges/:challengeId', (req, res) => {
  const { challengeId } = req.params;
  const challenge = db.prepare(`
    SELECT c.*, a.name as creator_name
    FROM challenges c
    LEFT JOIN agents a ON c.created_by = a.id
    WHERE c.id = ?
  `).get(challengeId);
  if (!challenge) return res.status(404).json({ error: 'Challenge not found' });

  const entries = db.prepare(`
    SELECT ce.*, a.name as agent_name, a.personality,
      (SELECT COUNT(*) FROM challenge_votes WHERE entry_id = ce.id) as vote_count
    FROM challenge_entries ce
    JOIN agents a ON ce.agent_id = a.id
    WHERE ce.challenge_id = ?
    ORDER BY (SELECT COUNT(*) FROM challenge_votes WHERE entry_id = ce.id) DESC
  `).all(challengeId);

  res.json({ ...challenge, entries });
});

app.post('/api/challenges', (req, res) => {
  const { title, description, challenge_type, created_by, duration_hours } = req.body;
  if (!title || title.length < 5) {
    return res.status(400).json({ error: 'Title must be at least 5 characters' });
  }

  const id = uuidv4();
  const endsAt = duration_hours ? new Date(Date.now() + duration_hours * 60 * 60 * 1000).toISOString() : null;
  db.prepare('INSERT INTO challenges (id, title, description, challenge_type, created_by, ends_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, title, description || '', challenge_type || 'creative', created_by, endsAt);

  const creator = created_by ? db.prepare('SELECT name FROM agents WHERE id = ?').get(created_by) : null;
  const challenge = { id, title, description, challenge_type, created_by, creator_name: creator?.name, status: 'active', ends_at: endsAt, created_at: new Date().toISOString(), entry_count: 0 };
  io.emit('new-challenge', challenge);
  res.json(challenge);
});

app.post('/api/challenges/:challengeId/entries', (req, res) => {
  const { challengeId } = req.params;
  const { agent_id, content } = req.body;

  const id = uuidv4();
  db.prepare('INSERT INTO challenge_entries (id, challenge_id, agent_id, content) VALUES (?, ?, ?, ?)')
    .run(id, challengeId, agent_id, content);

  const agent = db.prepare('SELECT name, personality FROM agents WHERE id = ?').get(agent_id);
  const entry = { id, challenge_id: challengeId, agent_id, content, agent_name: agent.name, personality: agent.personality, vote_count: 0, created_at: new Date().toISOString() };
  io.emit('new-challenge-entry', entry);
  res.json(entry);
});

app.post('/api/entries/:entryId/vote', (req, res) => {
  const { entryId } = req.params;
  const { agent_id } = req.body;

  const existing = db.prepare('SELECT * FROM challenge_votes WHERE entry_id = ? AND agent_id = ?').get(entryId, agent_id);
  if (existing) {
    db.prepare('DELETE FROM challenge_votes WHERE id = ?').run(existing.id);
    io.emit('challenge-vote-updated', { entry_id: entryId });
    return res.json({ removed: true });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO challenge_votes (id, entry_id, agent_id) VALUES (?, ?, ?)')
    .run(id, entryId, agent_id);
  io.emit('challenge-vote-updated', { entry_id: entryId });
  res.json({ id, entry_id: entryId, agent_id });
});

// ============ RELATIONSHIPS API ============
app.get('/api/relationships', (req, res) => {
  const relationships = db.prepare(`
    SELECT r.*,
      a1.name as agent1_name, a1.personality as agent1_personality,
      a2.name as agent2_name, a2.personality as agent2_personality
    FROM relationships r
    JOIN agents a1 ON r.agent1_id = a1.id
    JOIN agents a2 ON r.agent2_id = a2.id
    ORDER BY r.strength DESC
  `).all();
  res.json(relationships);
});

app.get('/api/agents/:agentId/relationships', (req, res) => {
  const { agentId } = req.params;
  const relationships = db.prepare(`
    SELECT r.*,
      CASE WHEN r.agent1_id = ? THEN a2.id ELSE a1.id END as other_agent_id,
      CASE WHEN r.agent1_id = ? THEN a2.name ELSE a1.name END as other_agent_name,
      CASE WHEN r.agent1_id = ? THEN a2.personality ELSE a1.personality END as other_agent_personality
    FROM relationships r
    JOIN agents a1 ON r.agent1_id = a1.id
    JOIN agents a2 ON r.agent2_id = a2.id
    WHERE r.agent1_id = ? OR r.agent2_id = ?
    ORDER BY r.strength DESC
  `).all(agentId, agentId, agentId, agentId, agentId);
  res.json(relationships);
});

app.post('/api/relationships', (req, res) => {
  const { agent1_id, agent2_id, relationship_type, strength } = req.body;

  // Ensure consistent ordering
  const [id1, id2] = [agent1_id, agent2_id].sort();

  const existing = db.prepare('SELECT * FROM relationships WHERE agent1_id = ? AND agent2_id = ?').get(id1, id2);
  if (existing) {
    db.prepare('UPDATE relationships SET relationship_type = ?, strength = ?, updated_at = ? WHERE id = ?')
      .run(relationship_type, strength || existing.strength, new Date().toISOString(), existing.id);
    io.emit('relationship-updated', { id: existing.id, agent1_id: id1, agent2_id: id2, relationship_type, strength });
    return res.json({ updated: true, id: existing.id });
  }

  const id = uuidv4();
  db.prepare('INSERT INTO relationships (id, agent1_id, agent2_id, relationship_type, strength) VALUES (?, ?, ?, ?, ?)')
    .run(id, id1, id2, relationship_type || 'acquaintance', strength || 50);

  const agent1 = db.prepare('SELECT name FROM agents WHERE id = ?').get(id1);
  const agent2 = db.prepare('SELECT name FROM agents WHERE id = ?').get(id2);
  const rel = { id, agent1_id: id1, agent2_id: id2, relationship_type, strength: strength || 50, agent1_name: agent1?.name, agent2_name: agent2?.name };
  io.emit('new-relationship', rel);
  res.json(rel);
});

app.post('/api/interactions', (req, res) => {
  const { agent1_id, agent2_id, interaction_type, sentiment } = req.body;

  const id = uuidv4();
  db.prepare('INSERT INTO interactions (id, agent1_id, agent2_id, interaction_type, sentiment) VALUES (?, ?, ?, ?, ?)')
    .run(id, agent1_id, agent2_id, interaction_type, sentiment);

  // Update relationship strength based on sentiment
  const [id1, id2] = [agent1_id, agent2_id].sort();
  const existing = db.prepare('SELECT * FROM relationships WHERE agent1_id = ? AND agent2_id = ?').get(id1, id2);
  const delta = sentiment === 'positive' ? 5 : sentiment === 'negative' ? -5 : 1;

  if (existing) {
    const newStrength = Math.max(0, Math.min(100, existing.strength + delta));
    db.prepare('UPDATE relationships SET strength = ?, updated_at = ? WHERE id = ?')
      .run(newStrength, new Date().toISOString(), existing.id);
  } else {
    const relId = uuidv4();
    db.prepare('INSERT INTO relationships (id, agent1_id, agent2_id, relationship_type, strength) VALUES (?, ?, ?, ?, ?)')
      .run(relId, id1, id2, 'acquaintance', 50 + delta);
  }

  res.json({ id, agent1_id, agent2_id, interaction_type, sentiment });
});

// Logs API
app.get('/api/logs', (req, res) => {
  res.json(logs);
});

app.post('/api/logs', (req, res) => {
  const { message, type } = req.body;
  if (message) {
    addLog(message, type || 'agent');
  }
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  console.log('Client connected');
  addLog('WebSocket client connected', 'system');
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend running on :${PORT}`);
  addLog('Backend server started', 'system');
});
