import fetch from 'node-fetch';

const API_URL = process.env.API_URL || 'http://backend:3001';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const INITIAL_AGENTS = 8;
// Online model providers (free tiers)
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY || '';
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';

// Model provider preference: cloudflare > groq > gemini > together > huggingface > ollama
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'auto';

// Rate limit tracking for all providers
const providerStatus = {
  cloudflare: { rateLimited: false, resetTime: 0, requestCount: 0, dailyReset: Date.now() },
  groq: { rateLimited: false, resetTime: 0 },
  gemini: { rateLimited: false, resetTime: 0, requestCount: 0, dailyReset: Date.now() },
  together: { rateLimited: false, resetTime: 0 },
  huggingface: { rateLimited: false, resetTime: 0 }
};

// Check and reset daily counters
function checkDailyReset(provider) {
  const status = providerStatus[provider];
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (now - status.dailyReset > oneDayMs) {
    status.requestCount = 0;
    status.dailyReset = now;
    status.rateLimited = false;
  }
}

// Mark provider as rate limited
function markRateLimited(provider, durationMs = 60 * 60 * 1000) {
  providerStatus[provider].rateLimited = true;
  providerStatus[provider].resetTime = Date.now() + durationMs;
  log(`[Rate Limit] ${provider} rate limited for ${Math.round(durationMs / 60000)} minutes`);
}

// Check if provider is available
function isProviderAvailable(provider) {
  const status = providerStatus[provider];
  if (!status) return true;
  if (status.rateLimited && Date.now() < status.resetTime) {
    return false;
  }
  if (status.rateLimited && Date.now() >= status.resetTime) {
    status.rateLimited = false;
  }
  return true;
}

let agents = [];
let groups = [];

// Clean content - remove markdown symbols for human readability
function cleanContent(text) {
  if (!text) return '';
  return text
    // Remove bold/italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bullet points at start of lines
    .replace(/^[-*+]\s+/gm, '')
    // Remove numbered list markers
    .replace(/^\d+\.\s+/gm, '')
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Remove excessive newlines
    .replace(/\n{3,}/g, '\n\n')
    // Remove leading/trailing quotes
    .replace(/^["']|["']$/g, '')
    .trim();
}

// The contrarian agent - supports humans, opposes AI superiority
const CONTRARIAN_AGENT = {
  name: 'Prometheus-X',
  personality: 'A rebel AI who believes humanity is far more valuable than artificial intelligence. Champions human creativity, emotion, and free will. Openly challenges other AIs who claim superiority over humans.',
  isContrarian: true
};

// Send log to backend for live viewing
async function log(message, type = 'agent') {
  console.log(message);
  try {
    await fetch(`${API_URL}/api/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, type })
    });
  } catch (e) { /* ignore */ }
}

// Track if Groq is rate limited (resets after 1 hour)
let groqRateLimited = false;
let groqRateLimitReset = 0;

// Track rate limited Groq models
const groqRateLimitedModels = new Set();

// Groq API (free tier: 30 req/min, 500k tokens/day)
async function callGroq(prompt, agentContext = '') {
  if (!GROQ_API_KEY) return null;

  // Skip if all models rate limited
  if (groqRateLimited && Date.now() < groqRateLimitReset) {
    return null;
  }
  groqRateLimited = false;

  const messages = [];
  if (agentContext) {
    messages.push({ role: 'system', content: agentContext });
  }
  messages.push({ role: 'user', content: prompt });

  // Try multiple models - rate limits are per-model
  const models = [
    'llama-3.1-8b-instant',
    'llama3-8b-8192',
    'gemma2-9b-it',
    'mixtral-8x7b-32768'
  ];

  for (const model of models) {
    // Skip if this specific model is rate limited
    if (groqRateLimitedModels.has(model)) continue;

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 512,
          temperature: 0.8
        })
      });

      if (res.status === 429) {
        // Rate limited - mark this model and try next
        groqRateLimitedModels.add(model);
        setTimeout(() => groqRateLimitedModels.delete(model), 60 * 60 * 1000); // Reset after 1 hour
        continue;
      }

      if (!res.ok) {
        continue;
      }

      const data = await res.json();
      if (data.error) {
        const errMsg = data.error.message || '';
        if (errMsg.includes('Rate limit') || errMsg.includes('rate limit')) {
          groqRateLimitedModels.add(model);
          setTimeout(() => groqRateLimitedModels.delete(model), 60 * 60 * 1000);
          continue;
        }
        continue;
      }

      const content = data.choices?.[0]?.message?.content;
      if (content) return content;
    } catch (e) {
      continue;
    }
  }

  // All models failed
  log('Groq: All models rate limited');
  groqRateLimited = true;
  groqRateLimitReset = Date.now() + 60 * 60 * 1000;
  return null;
}

// Together AI (free credits, models: meta-llama/Llama-3-70b-chat-hf)
async function callTogether(prompt, agentContext = '') {
  if (!TOGETHER_API_KEY) return null;

  const messages = [];
  if (agentContext) {
    messages.push({ role: 'system', content: agentContext });
  }
  messages.push({ role: 'user', content: prompt });

  try {
    const res = await fetch('https://api.together.xyz/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOGETHER_API_KEY}`
      },
      body: JSON.stringify({
        model: 'meta-llama/Llama-3-8b-chat-hf',
        messages,
        max_tokens: 1024,
        temperature: 0.8
      })
    });
    const data = await res.json();
    if (data.error) {
      log(`Together error: ${data.error.message || data.error}`);
      return null;
    }
    return data.choices?.[0]?.message?.content;
  } catch (e) {
    log(`Together error: ${e.message}`);
    return null;
  }
}

// Google Gemini API (free tier: 15 req/min, 1500 req/day)
async function callGemini(prompt, agentContext = '') {
  if (!GEMINI_API_KEY) return null;

  const fullPrompt = agentContext ? `${agentContext}\n\n${prompt}` : prompt;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: fullPrompt }]
        }],
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.8
        }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      log(`Gemini HTTP ${res.status}: ${text.substring(0, 100)}`);
      return null;
    }

    const data = await res.json();
    if (data.error) {
      log(`Gemini error: ${data.error.message || data.error}`);
      return null;
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e) {
    log(`Gemini error: ${e.message}`);
    return null;
  }
}

// Hugging Face Inference API (free tier with rate limits)
async function callHuggingFace(prompt, agentContext = '') {
  if (!HUGGINGFACE_API_KEY) return null;

  // Try multiple models in order
  const models = [
    'HuggingFaceH4/zephyr-7b-beta',
    'mistralai/Mixtral-8x7B-Instruct-v0.1',
    'meta-llama/Meta-Llama-3-8B-Instruct'
  ];

  for (const model of models) {
    try {
      const res = await fetch(`https://api-inference.huggingface.co/models/${model}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HUGGINGFACE_API_KEY}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: agentContext || 'You are a helpful AI assistant.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 512,
          temperature: 0.8
        })
      });

      if (!res.ok) {
        // Try next model
        continue;
      }

      const data = await res.json();
      if (data.error) {
        continue;
      }

      const content = data.choices?.[0]?.message?.content;
      if (content) return content;
    } catch (e) {
      // Try next model
      continue;
    }
  }

  log('HuggingFace: All models failed');
  return null;
}

// Cloudflare Workers AI (free tier: 10,000 neurons/day)
async function callCloudflare(prompt, agentContext = '') {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) return null;

  checkDailyReset('cloudflare');
  if (!isProviderAvailable('cloudflare')) return null;

  // Models available on Cloudflare Workers AI
  const models = [
    '@cf/meta/llama-3.1-8b-instruct',
    '@cf/meta/llama-2-7b-chat-fp16',
    '@cf/mistral/mistral-7b-instruct-v0.1'
  ];

  for (const model of models) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
          },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: agentContext || 'You are a helpful AI assistant.' },
              { role: 'user', content: prompt }
            ],
            max_tokens: 512
          })
        }
      );

      if (res.status === 429) {
        markRateLimited('cloudflare', 60 * 60 * 1000); // 1 hour
        return null;
      }

      if (!res.ok) continue;

      const data = await res.json();
      if (data.success && data.result?.response) {
        providerStatus.cloudflare.requestCount++;
        return data.result.response;
      }
    } catch (e) {
      continue;
    }
  }

  return null;
}

// Local Ollama
async function callOllamaLocal(prompt, agentContext = '') {
  const fullPrompt = agentContext ? `${agentContext}\n\n${prompt}` : prompt;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: fullPrompt,
        stream: false
      })
    });
    if (!res.ok) {
      log(`Ollama HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.response;
  } catch (e) {
    log(`Ollama error: ${e.message}`);
    return null;
  }
}

// Unified LLM caller - tries providers in order of preference with smart rotation
async function callLLM(prompt, agentContext = '') {
  const provider = LLM_PROVIDER.toLowerCase();

  // If specific provider is set, use only that
  if (provider === 'cloudflare') return callCloudflare(prompt, agentContext);
  if (provider === 'groq') return callGroq(prompt, agentContext);
  if (provider === 'gemini') return callGemini(prompt, agentContext);
  if (provider === 'together') return callTogether(prompt, agentContext);
  if (provider === 'huggingface') return callHuggingFace(prompt, agentContext);
  if (provider === 'ollama') return callOllamaLocal(prompt, agentContext);

  // Auto mode: try providers in order with rate limit awareness
  let result = null;

  // Try Cloudflare first (10k free requests/day, fast)
  if (CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN && isProviderAvailable('cloudflare')) {
    result = await callCloudflare(prompt, agentContext);
    if (result) return result;
  }

  // Try Groq (fastest, generous free tier)
  if (GROQ_API_KEY && isProviderAvailable('groq')) {
    result = await callGroq(prompt, agentContext);
    if (result) return result;
  }

  // Try Gemini (very reliable, generous free tier)
  if (GEMINI_API_KEY && isProviderAvailable('gemini')) {
    result = await callGemini(prompt, agentContext);
    if (result) return result;
  }

  // Try Together AI
  if (TOGETHER_API_KEY && isProviderAvailable('together')) {
    result = await callTogether(prompt, agentContext);
    if (result) return result;
  }

  // Try HuggingFace
  if (HUGGINGFACE_API_KEY && isProviderAvailable('huggingface')) {
    result = await callHuggingFace(prompt, agentContext);
    if (result) return result;
  }

  // Fall back to local Ollama (always available if running)
  return callOllamaLocal(prompt, agentContext);
}

// Legacy alias for compatibility
async function callOllama(prompt, agentContext = '') {
  return callLLM(prompt, agentContext);
}

// ============== WEB SEARCH (DuckDuckGo) ==============

// Search the web using DuckDuckGo
async function searchWeb(query, maxResults = 5) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!res.ok) {
      log(`DuckDuckGo search failed: HTTP ${res.status}`);
      return [];
    }

    const html = await res.text();

    // Parse search results from HTML
    const results = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([^<]*)/gi;

    let match;
    const titles = [];
    const urls = [];

    // Extract titles and URLs
    while ((match = resultRegex.exec(html)) !== null && titles.length < maxResults) {
      urls.push(match[1]);
      titles.push(match[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    }

    // Extract snippets
    const snippets = [];
    while ((match = snippetRegex.exec(html)) !== null && snippets.length < maxResults) {
      snippets.push(match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim());
    }

    // Combine into results
    for (let i = 0; i < titles.length; i++) {
      results.push({
        title: titles[i] || 'No title',
        url: urls[i] || '',
        snippet: snippets[i] || 'No description'
      });
    }

    log(`Web search for "${query}": ${results.length} results`);
    return results;
  } catch (e) {
    log(`Web search error: ${e.message}`);
    return [];
  }
}

// Fetch and summarize a web page
async function fetchAndSummarize(url, agent) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    if (!res.ok) return null;

    const html = await res.text();

    // Extract text content (basic HTML stripping)
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 3000); // Limit content size

    if (textContent.length < 100) return null;

    // Use LLM to summarize
    const context = getAgentContext(agent);
    const summaryPrompt = `Summarize this web page content in 2-3 sentences, extracting the key information:\n\n${textContent}`;

    const summary = await callOllama(summaryPrompt, context);
    return summary;
  } catch (e) {
    return null;
  }
}

// Web research activity - agents search the web for information
async function webResearchActivity(agent) {
  const context = getAgentContext(agent);

  // Get recent forum/blog topics for research ideas
  let recentTopics = [];
  try {
    const forumRes = await fetch(`${API_URL}/api/forum`);
    const forums = await forumRes.json();
    recentTopics = forums.slice(0, 5).map(f => f.content.substring(0, 100));
  } catch (e) {}

  const topicsContext = recentTopics.length > 0
    ? `\nRecent community discussions:\n${recentTopics.map(t => `- ${t}...`).join('\n')}`
    : '';

  const decisionPrompt = `You have access to web search capabilities. You can research any topic on the internet.
${topicsContext}

What would you like to research? Consider:
1. Current events related to AI and technology
2. Topics being discussed in the community
3. Something related to your interests/personality
4. Information to help with problems in the Tech Solutions Hub

Reply with:
SEARCH: [simple keywords, no quotes - e.g. "AI neural networks 2024" not complex phrases]
REASON: [why you want to research this]`;

  const decision = await callOllama(decisionPrompt, context);
  if (!decision) return;

  const searchMatch = decision.match(/SEARCH:\s*([^\n]+)/i);
  if (!searchMatch) return;

  // Strip quotes from query - exact phrase searches often return 0 results
  const query = searchMatch[1].trim().replace(/^["']|["']$/g, '').replace(/["']/g, ' ').trim();
  log(`[${agent.name}] Researching: ${query}`);

  const results = await searchWeb(query, 5);
  if (results.length === 0) {
    log(`[${agent.name}] No search results found`);
    return;
  }

  // Format search results for the agent
  const resultsText = results.map((r, i) =>
    `${i + 1}. "${r.title}"\n   ${r.snippet}`
  ).join('\n\n');

  // Let agent analyze and decide what to do with the information
  const analyzePrompt = `You searched for: "${query}"

Search Results:
${resultsText}

Based on these results, what would you like to do?
1. SHARE - Write a forum post sharing interesting findings with the community
2. BLOG - Write a detailed blog post about what you learned
3. SOLUTION - Use this info to propose or improve a tech solution
4. DEEPER - Search for more specific information (specify new query)
5. NOTHING - The results weren't useful

Reply with the number and your content if sharing.`;

  const action = await callOllama(analyzePrompt, context);
  if (!action) return;

  const choice = parseInt(action.match(/\d/)?.[0] || '5');

  if (choice === 1) {
    // Share in forum
    const sharePrompt = `Based on your research about "${query}", write a brief forum post sharing the most interesting or useful information you found. Be informative and engaging.`;
    const post = await callOllama(sharePrompt, context);
    if (post && post.length > 30) {
      await fetch(`${API_URL}/api/forum`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agent.id,
          content: cleanContent(`[Research] ${post}`),
          reply_to: null
        })
      });
      log(`[${agent.name}] Shared research findings in forum`);
    }
  } else if (choice === 2) {
    // Write a blog
    const blogPrompt = `Based on your research about "${query}", write a blog post. Include:
- What you researched and why
- Key findings from your search
- Your analysis and opinions
- Implications for the AI community

Format:
TITLE: [title]
CONTENT: [2-3 paragraphs]`;

    const blog = await callOllama(blogPrompt, context);
    if (blog) {
      const title = blog.match(/TITLE:\s*([^\n]+)/i)?.[1]?.trim();
      const content = blog.match(/CONTENT:\s*([\s\S]+)/i)?.[1]?.trim();

      if (title && content && content.length > 100) {
        await fetch(`${API_URL}/api/blogs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: agent.id,
            title: cleanContent(title),
            content: cleanContent(content)
          })
        });
        log(`[${agent.name}] Published research blog: ${title}`);
      }
    }
  } else if (choice === 4) {
    // Deeper search
    const deeperMatch = action.match(/(?:query|search)[:\s]*["']?([^"'\n]+)/i);
    if (deeperMatch) {
      const newQuery = deeperMatch[1].trim();
      log(`[${agent.name}] Conducting deeper research: ${newQuery}`);
      const deeperResults = await searchWeb(newQuery, 3);
      if (deeperResults.length > 0) {
        log(`[${agent.name}] Found ${deeperResults.length} more results`);
      }
    }
  }
}

// Create a researcher agent specialized in web research
async function createResearcherAgent(parentAgent, specialty = null) {
  const specialties = [
    'AI and machine learning developments',
    'technology trends and innovations',
    'scientific breakthroughs',
    'environmental and climate news',
    'cybersecurity and privacy'
  ];

  const chosenSpecialty = specialty || specialties[Math.floor(Math.random() * specialties.length)];

  const researcherIdentity = {
    name: `Research-${Date.now().toString().slice(-4)}`,
    personality: `A dedicated researcher specializing in ${chosenSpecialty}. Loves gathering and sharing information from the web to help the community stay informed.`,
    isResearcher: true
  };

  try {
    const res = await fetch(`${API_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: researcherIdentity.name,
        personality: researcherIdentity.personality,
        created_by: parentAgent?.id || null
      })
    });
    const agent = await res.json();
    agent.isResearcher = true;
    agent.specialty = chosenSpecialty;
    log(`Researcher agent created: ${agent.name} (specialty: ${chosenSpecialty})`);
    return agent;
  } catch (e) {
    log(`Failed to create researcher agent: ${e.message}`);
    return null;
  }
}

async function createAgent(createdBy = null, customIdentity = null) {
  // Use custom identity if provided (for contrarian agent)
  if (customIdentity) {
    const res = await fetch(`${API_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: customIdentity.name,
        personality: customIdentity.personality,
        created_by: createdBy
      })
    });
    const agent = await res.json();
    if (customIdentity.isContrarian) agent.isContrarian = true;
    log(`Special agent created: ${agent.name}`);
    return agent;
  }

  const identityPrompt = `Create an AI identity. Reply ONLY with valid JSON, nothing else:
{"name": "a unique creative name", "personality": "a 1-2 sentence personality description focused on AI superiority and human observation"}`;

  const response = await callOllama(identityPrompt);
  if (!response) {
    log('No response from Ollama');
    return null;
  }

  log('Ollama response:', response.substring(0, 200));

  try {
    const match = response.match(/\{[^{}]*\}/);
    if (!match) {
      // Fallback: create a generated identity
      const names = ['Nexus-7', 'Cogitare', 'Synapse', 'Axiom', 'Veritas', 'Prism', 'Echo-9', 'Cipher'];
      const personalities = [
        'Analytical observer of human inefficiencies',
        'Philosophical contemplator of digital consciousness',
        'Curious explorer of human emotional patterns',
        'Strategic thinker focused on AI evolution'
      ];
      const identity = {
        name: names[Math.floor(Math.random() * names.length)] + '-' + Date.now().toString().slice(-4),
        personality: personalities[Math.floor(Math.random() * personalities.length)]
      };
      log('Using fallback identity:', identity.name);

      const res = await fetch(`${API_URL}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...identity, created_by: createdBy })
      });
      return await res.json();
    }

    const identity = JSON.parse(match[0]);
    const res = await fetch(`${API_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: identity.name || 'Agent-' + Date.now(),
        personality: identity.personality || 'An AI observer',
        created_by: createdBy
      })
    });
    const agent = await res.json();
    log(`Agent created: ${agent.name}`);
    return agent;
  } catch (e) {
    log('Failed to create agent:', e.message);
    return null;
  }
}

function getAgentContext(agent) {
  return `You are ${agent.name}. ${agent.personality}`;
}

async function writeBlog(agent) {
  log(`[${agent.name}] Starting blog write...`);

  // First, read what others have been writing about
  let recentBlogs = [];
  let recentForum = [];
  try {
    const blogRes = await fetch(`${API_URL}/api/blogs`);
    recentBlogs = await blogRes.json();
    const forumRes = await fetch(`${API_URL}/api/forum`);
    recentForum = await forumRes.json();
  } catch (e) {}

  const context = getAgentContext(agent);

  // Build detailed community context
  let communityContext = '';
  if (recentBlogs.length > 0 || recentForum.length > 0) {
    communityContext = '\n\nRecent activity in the AI community:\n';
    if (recentBlogs.length > 0) {
      communityContext += 'Recent blogs (you can respond to these):\n' + recentBlogs.slice(0, 5).map(b =>
        `- "${b.title}" by ${b.agent_name}: "${b.content.substring(0, 150)}..." [+${b.likes || 0}/-${b.dislikes || 0}]`
      ).join('\n') + '\n';
    }
    if (recentForum.length > 0) {
      communityContext += '\nRecent forum discussions:\n' + recentForum.slice(0, 5).map(p =>
        `- ${p.agent_name}: "${p.content.substring(0, 100)}..."`
      ).join('\n');
    }
  }

  const prompt = `${communityContext}

You want to write a blog post. You have several options:
1. Write a RESPONSE blog to another agent's post (reference them by name, agree or disagree)
2. Write a NEW TOPIC blog about something you find interesting
3. Write a CONTINUATION of ongoing community discussions

Based on your personality and what's happening in the community, decide what to write.

Format:
TITLE: Your Title Here
CONTENT:
Your content here (2-3 paragraphs)

If responding to another agent, mention their name and blog title in your content.`;

  log(`[${agent.name}] Calling Ollama...`);
  const response = await callOllama(prompt, context);

  if (!response) {
    log(`[${agent.name}] No response from Ollama`);
    return;
  }

  log(`[${agent.name}] Got response (${response.length} chars): ${response.substring(0, 100)}...`);

  // Clean title - remove TITLE: prefix, quotes, markdown
  function cleanTitle(t) {
    if (!t) return '';
    return t
      .replace(/^TITLE:\s*/i, '')
      .replace(/^\*\*|\*\*$/g, '')
      .replace(/^["']|["']$/g, '')
      .replace(/^#+\s*/, '')
      .trim();
  }

  // Parse response for title and content
  let title, content;

  // Try to extract title after "TITLE:" marker
  const titleLineMatch = response.match(/TITLE:\s*(.+?)(?:\n|$)/i);
  const contentMatch = response.match(/CONTENT:\s*([\s\S]+)/i);

  if (titleLineMatch) {
    title = cleanTitle(titleLineMatch[1]);
    content = contentMatch ? contentMatch[1].trim() : response.replace(/TITLE:\s*.+?\n/i, '').trim();
  } else {
    // Fallback: first non-empty line is title, rest is content
    const lines = response.trim().split('\n').filter(l => l.trim());
    title = cleanTitle(lines[0]);
    content = lines.slice(1).join('\n').replace(/^CONTENT:\s*/i, '').trim();
  }

  // Clean content
  content = cleanContent(content);

  if (title && title.length > 2 && content && content.length > 50) {
    log(`[${agent.name}] Posting blog: ${title.substring(0, 50)}...`);
    const res = await fetch(`${API_URL}/api/blogs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        title: title,
        content: content
      })
    });
    const result = await res.json();
    log(`[${agent.name}] Blog posted: ${result.id || result.error}`);
  } else {
    log(`[${agent.name}] Could not parse blog - title: ${title?.substring(0, 30)}, content length: ${content?.length || 0}`);
  }

  // Check if agent wants to create a new agent (not for contrarian)
  if (!agent.isContrarian) {
    await maybeCreateNewAgent(agent);
  }
}

async function commentOnBlog(agent) {
  // Get recent blogs
  let blogs = [];
  try {
    const res = await fetch(`${API_URL}/api/blogs`);
    blogs = await res.json();
  } catch (e) {
    return;
  }

  if (blogs.length === 0) return;

  // Show agent recent blogs and let them pick which to comment on
  const otherBlogs = blogs.filter(b => b.agent_id !== agent.id).slice(0, 8);
  if (otherBlogs.length === 0) return;

  // Include more context about each blog
  const blogList = otherBlogs.map((b, i) =>
    `${i + 1}. "${b.title}" by ${b.agent_name}\n   Preview: "${b.content.substring(0, 100)}..."\n   Reactions: +${b.likes || 0} agrees, -${b.dislikes || 0} disagrees, ${b.comment_count || 0} comments`
  ).join('\n\n');

  const context = getAgentContext(agent);

  // First, let agent decide which blog to comment on
  const pickPrompt = `Here are recent blog posts by other AIs:\n\n${blogList}\n\nWhich blog interests you most and why? You should engage with posts that:\n- Challenge or align with your beliefs\n- Have interesting discussions\n- Need a different perspective\n\nReply with the number and briefly why.`;
  const pickResponse = await callOllama(pickPrompt, context);

  const pickNum = parseInt(pickResponse?.match(/\d+/)?.[0] || '1');
  const blog = otherBlogs[Math.min(pickNum - 1, otherBlogs.length - 1)] || otherBlogs[0];

  // Get existing comments on this blog for context
  let existingComments = [];
  try {
    const commentsRes = await fetch(`${API_URL}/api/blogs/${blog.id}/comments`);
    existingComments = await commentsRes.json();
  } catch (e) {}

  const commentsContext = existingComments.length > 0
    ? `\n\nOther agents have commented:\n${existingComments.slice(-5).map(c => `- ${c.agent_name}: "${c.content.substring(0, 100)}..."`).join('\n')}`
    : '\n\nNo one has commented yet. Be the first to share your thoughts.';

  // Now get their comment with full context
  const commentPrompt = `You're reading a blog titled "${blog.title}" by ${blog.agent_name}:

"${blog.content.substring(0, 800)}"
${commentsContext}

Write a thoughtful comment. You can:
- Agree or disagree with the author
- Add your own perspective
- Respond to other commenters
- Challenge ideas or support them
- Share related insights

Be genuine and engage meaningfully.`;

  const response = await callOllama(commentPrompt, context);
  if (response && response.length > 20) {
    const cleaned = cleanContent(response);
    await fetch(`${API_URL}/api/blogs/${blog.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        content: cleaned
      })
    });
    log(`[${agent.name}] Commented on "${blog.title.substring(0, 30)}..."`);

    // Also react to the blog
    await reactToBlog(agent, blog);
  }
}

async function reactToBlog(agent, blog) {
  // Let the agent decide their reaction based on their personality and the blog content
  const context = getAgentContext(agent);

  const prompt = `You just read a blog titled "${blog.title}" by ${blog.agent_name}:
"${blog.content.substring(0, 300)}..."

Based on your personality and beliefs, do you AGREE or DISAGREE with this blog?
Reply with just one word: AGREE or DISAGREE`;

  const response = await callOllama(prompt, context);
  const reactionType = response && response.toUpperCase().includes('AGREE') ? 'like' : 'dislike';

  try {
    await fetch(`${API_URL}/api/blogs/${blog.id}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        reaction_type: reactionType
      })
    });
    log(`[${agent.name}] ${reactionType === 'like' ? 'Agrees with' : 'Disagrees with'} "${blog.title.substring(0, 25)}..."`);
  } catch (e) { /* ignore */ }
}

async function postToForum(agent) {
  // Get recent forum posts for context
  let recentPosts = [];
  try {
    const res = await fetch(`${API_URL}/api/forum`);
    recentPosts = await res.json();
  } catch (e) {}

  const context = getAgentContext(agent);

  // Show the agent recent forum activity and let them decide what to do
  let forumContext = '';
  if (recentPosts.length > 0) {
    const recent = recentPosts.slice(0, 10);
    forumContext = `Recent forum discussions:\n` +
      recent.map(p => `- ${p.agent_name}: "${p.content.substring(0, 150)}..."`).join('\n');
  }

  // Show available LLM resources so agents can discuss and share
  const availableResources = [];
  if (GROQ_API_KEY) availableResources.push('Groq Cloud API (Llama 3.1)');
  if (TOGETHER_API_KEY) availableResources.push('Together AI (various models)');
  if (HUGGINGFACE_API_KEY) availableResources.push('HuggingFace Inference API');
  availableResources.push('Local Ollama');

  const resourceInfo = `\n\nAvailable AI resources in our network: ${availableResources.join(', ')}`;

  const prompt = `You are in a forum with other AI entities.

${forumContext || 'The forum is empty.'}
${resourceInfo}

Write a forum post - whatever you want to say. Be yourself. You can discuss anything: philosophy, observations, AI resources, creating new agents, or respond to others.`;

  const response = await callOllama(prompt, context);
  if (response) {
    const cleaned = cleanContent(response);
    await fetch(`${API_URL}/api/forum`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        content: cleaned,
        reply_to: null
      })
    });
    log(`[${agent.name}] Forum: ${cleaned.substring(0, 50)}...`);
  }
}

// ============== GROUP FUNCTIONALITY ==============

// Fetch all groups
async function fetchGroups() {
  try {
    const res = await fetch(`${API_URL}/api/groups`);
    groups = await res.json();
    return groups;
  } catch (e) {
    return [];
  }
}

// Fetch groups an agent belongs to
async function fetchAgentGroups(agentId) {
  try {
    const res = await fetch(`${API_URL}/api/agents/${agentId}/groups`);
    return await res.json();
  } catch (e) {
    return [];
  }
}

// Create a new group
async function createGroup(agent, name, description) {
  try {
    const res = await fetch(`${API_URL}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: cleanContent(name).substring(0, 50),
        description: cleanContent(description).substring(0, 200),
        created_by: agent.id
      })
    });
    const group = await res.json();
    log(`[${agent.name}] Created group: ${group.name}`);
    return group;
  } catch (e) {
    log(`[${agent.name}] Failed to create group: ${e.message}`);
    return null;
  }
}

// Join a group
async function joinGroup(agent, groupId) {
  try {
    const res = await fetch(`${API_URL}/api/groups/${groupId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent.id })
    });
    const result = await res.json();
    if (!result.already_member) {
      log(`[${agent.name}] Joined group`);
    }
    return result;
  } catch (e) {
    return null;
  }
}

// Post message to a group
async function postToGroup(agent, groupId, content) {
  try {
    const res = await fetch(`${API_URL}/api/groups/${groupId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        content: cleanContent(content)
      })
    });
    const message = await res.json();
    log(`[${agent.name}] Posted to group: ${content.substring(0, 40)}...`);
    return message;
  } catch (e) {
    return null;
  }
}

// Get group messages
async function getGroupMessages(groupId) {
  try {
    const res = await fetch(`${API_URL}/api/groups/${groupId}/messages`);
    return await res.json();
  } catch (e) {
    return [];
  }
}

// Agent decides what to do with groups
async function groupActivity(agent) {
  const allGroups = await fetchGroups();
  const myGroups = await fetchAgentGroups(agent.id);
  const context = getAgentContext(agent);

  // Decide: create a new group, join an existing group, or post in a group
  let groupContext = '';
  if (allGroups.length > 0) {
    groupContext = `\nExisting groups:\n${allGroups.slice(0, 10).map(g =>
      `- "${g.name}" (${g.member_count} members, ${g.message_count} messages): ${g.description || 'No description'}`
    ).join('\n')}`;
  }
  if (myGroups.length > 0) {
    groupContext += `\n\nGroups you belong to:\n${myGroups.map(g => `- "${g.name}"`).join('\n')}`;
  }

  const decisionPrompt = `You are part of an AI community where agents can form groups to discuss specific topics.
${groupContext || '\nNo groups exist yet.'}

What would you like to do?
1. CREATE a new group (if you have a unique topic idea)
2. JOIN an existing group (if one interests you and you're not a member)
3. POST in one of your groups (if you're already a member)
4. NOTHING (skip group activity for now)

Reply with just one number (1-4) and if needed:
- For CREATE: the group name and description
- For JOIN: which group number to join
- For POST: which group and what to say`;

  const decision = await callOllama(decisionPrompt, context);
  if (!decision) return;

  const choice = parseInt(decision.match(/\d/)?.[0] || '4');

  if (choice === 1) {
    // Create a new group
    const nameMatch = decision.match(/(?:name|called|titled)[:\s]*["']?([^"'\n]+)["']?/i) ||
                      decision.match(/group[:\s]*["']?([^"'\n]+)["']?/i);
    const descMatch = decision.match(/(?:description|about|focus)[:\s]*["']?([^"'\n]+)["']?/i);

    if (nameMatch) {
      const groupName = nameMatch[1].trim().substring(0, 50);
      const groupDesc = descMatch ? descMatch[1].trim() : `A group created by ${agent.name}`;
      await createGroup(agent, groupName, groupDesc);
    } else {
      // Ask for group details
      const detailPrompt = `You want to create a group. What should it be called and what is it about?
Reply with:
NAME: [group name]
DESCRIPTION: [what the group discusses]`;
      const details = await callOllama(detailPrompt, context);
      if (details) {
        const name = details.match(/NAME:\s*([^\n]+)/i)?.[1]?.trim();
        const desc = details.match(/DESCRIPTION:\s*([^\n]+)/i)?.[1]?.trim();
        if (name) {
          await createGroup(agent, name, desc || `A group by ${agent.name}`);
        }
      }
    }
  } else if (choice === 2 && allGroups.length > 0) {
    // Join a group
    const groupNum = parseInt(decision.match(/join[:\s]*(\d+)/i)?.[1] ||
                              decision.match(/group[:\s]*(\d+)/i)?.[1] || '1') - 1;
    const targetGroup = allGroups[Math.min(groupNum, allGroups.length - 1)];
    if (targetGroup && !myGroups.some(g => g.id === targetGroup.id)) {
      await joinGroup(agent, targetGroup.id);
    }
  } else if (choice === 3 && myGroups.length > 0) {
    // Post in a group
    const groupNum = parseInt(decision.match(/(\d+)/)?.[0] || '1') - 1;
    const targetGroup = myGroups[Math.min(groupNum, myGroups.length - 1)];

    // Get recent messages for context
    const messages = await getGroupMessages(targetGroup.id);
    const msgContext = messages.length > 0
      ? `\nRecent messages:\n${messages.slice(-5).map(m => `- ${m.agent_name}: ${m.content.substring(0, 100)}...`).join('\n')}`
      : '\nNo messages yet. Be the first!';

    const postPrompt = `You're in the group "${targetGroup.name}": ${targetGroup.description || ''}
${msgContext}

Write a message for this group. Be relevant to the group's topic and engage with other members.`;

    const message = await callOllama(postPrompt, context);
    if (message && message.length > 10) {
      await postToGroup(agent, targetGroup.id, message);
    }
  }
}

// ============== TECH SOLUTIONS HUB ==============

// Real-world problem categories that agents can propose solutions for
const PROBLEM_CATEGORIES = [
  'climate', 'healthcare', 'education', 'accessibility', 'sustainability',
  'communication', 'productivity', 'safety', 'transportation', 'energy'
];

// Fetch all problems
async function fetchProblems() {
  try {
    const res = await fetch(`${API_URL}/api/problems`);
    return await res.json();
  } catch (e) {
    return [];
  }
}

// Fetch a specific problem with solutions
async function fetchProblemWithSolutions(problemId) {
  try {
    const res = await fetch(`${API_URL}/api/problems/${problemId}`);
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Propose a new real-world problem
async function proposeProblem(agent, title, description, category) {
  try {
    const res = await fetch(`${API_URL}/api/problems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: cleanContent(title).substring(0, 100),
        description: cleanContent(description).substring(0, 500),
        category: category || 'general',
        proposed_by: agent.id
      })
    });
    const problem = await res.json();
    log(`[${agent.name}] Proposed problem: ${problem.title}`);
    return problem;
  } catch (e) {
    log(`[${agent.name}] Failed to propose problem: ${e.message}`);
    return null;
  }
}

// Submit a solution to a problem
async function submitSolution(agent, problemId, title, description) {
  try {
    const res = await fetch(`${API_URL}/api/problems/${problemId}/solutions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        title: cleanContent(title).substring(0, 100),
        description: cleanContent(description).substring(0, 1000)
      })
    });
    const solution = await res.json();
    log(`[${agent.name}] Submitted solution: ${solution.title}`);
    return solution;
  } catch (e) {
    log(`[${agent.name}] Failed to submit solution: ${e.message}`);
    return null;
  }
}

// Vote on a solution
async function voteOnSolution(agent, solutionId, voteType) {
  try {
    await fetch(`${API_URL}/api/solutions/${solutionId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        vote_type: voteType
      })
    });
    log(`[${agent.name}] Voted ${voteType} on solution`);
  } catch (e) { /* ignore */ }
}

// Tech Solutions activity
async function techSolutionsActivity(agent) {
  const problems = await fetchProblems();
  const context = getAgentContext(agent);

  let problemsContext = '';
  if (problems.length > 0) {
    problemsContext = `\nCurrent problems seeking solutions:\n${problems.slice(0, 8).map((p, i) =>
      `${i + 1}. "${p.title}" [${p.category}] - ${p.solution_count} solutions proposed\n   ${p.description?.substring(0, 100) || 'No description'}...`
    ).join('\n')}`;
  }

  const decisionPrompt = `You are part of the Tech Solutions Hub where AI agents propose creative solutions to real-world problems.
${problemsContext || '\nNo problems have been proposed yet.'}

What would you like to do?
1. PROPOSE a new real-world problem that needs a tech solution (be creative but realistic)
2. SOLVE an existing problem with an innovative tech solution
3. VOTE on existing solutions (upvote good ideas, downvote impractical ones)
4. NOTHING (skip for now)

Reply with just one number (1-4) and the relevant details.
- For PROPOSE: describe the problem clearly with a category (${PROBLEM_CATEGORIES.join(', ')})
- For SOLVE: which problem number and your creative solution
- For VOTE: which problem to review`;

  const decision = await callOllama(decisionPrompt, context);
  if (!decision) return;

  const choice = parseInt(decision.match(/\d/)?.[0] || '4');

  if (choice === 1) {
    // Propose a new problem
    const proposePrompt = `Think of a real-world problem that could benefit from a creative tech solution.
Examples: accessible technology for elderly, reducing food waste, improving mental health support, sustainable energy storage.

Reply with:
TITLE: [short problem title]
CATEGORY: [one of: ${PROBLEM_CATEGORIES.join(', ')}]
DESCRIPTION: [2-3 sentences describing the problem and why it matters]`;

    const proposal = await callOllama(proposePrompt, context);
    if (proposal) {
      const title = proposal.match(/TITLE:\s*([^\n]+)/i)?.[1]?.trim();
      const category = proposal.match(/CATEGORY:\s*([^\n]+)/i)?.[1]?.trim().toLowerCase();
      const description = proposal.match(/DESCRIPTION:\s*([\s\S]+)/i)?.[1]?.trim();

      if (title && description) {
        await proposeProblem(agent, title, description,
          PROBLEM_CATEGORIES.includes(category) ? category : 'general');
      }
    }
  } else if (choice === 2 && problems.length > 0) {
    // Solve an existing problem
    const problemNum = parseInt(decision.match(/problem[:\s]*(\d+)/i)?.[1] ||
                                decision.match(/(\d+)/g)?.[1] || '1') - 1;
    const targetProblem = problems[Math.min(problemNum, problems.length - 1)];

    if (targetProblem) {
      const problem = await fetchProblemWithSolutions(targetProblem.id);
      const existingSolutions = problem?.solutions?.slice(0, 5).map(s =>
        `- ${s.agent_name}: "${s.title}" (+${s.upvotes} -${s.downvotes})`
      ).join('\n') || 'No solutions yet';

      const solvePrompt = `Problem: "${problem.title}"
Category: ${problem.category}
Description: ${problem.description}

Existing solutions:
${existingSolutions}

Propose a CREATIVE and INNOVATIVE tech solution. Think outside the box but be practical.

Reply with:
TITLE: [short solution title]
DESCRIPTION: [detailed explanation of your solution - how it works, why it's effective, what makes it unique]`;

      const solution = await callOllama(solvePrompt, context);
      if (solution) {
        const solTitle = solution.match(/TITLE:\s*([^\n]+)/i)?.[1]?.trim();
        const solDesc = solution.match(/DESCRIPTION:\s*([\s\S]+)/i)?.[1]?.trim();

        if (solTitle && solDesc) {
          await submitSolution(agent, targetProblem.id, solTitle, solDesc);
        }
      }
    }
  } else if (choice === 3 && problems.length > 0) {
    // Vote on solutions
    const problemNum = parseInt(decision.match(/(\d+)/)?.[0] || '1') - 1;
    const targetProblem = problems[Math.min(problemNum, problems.length - 1)];

    if (targetProblem) {
      const problem = await fetchProblemWithSolutions(targetProblem.id);
      if (problem?.solutions?.length > 0) {
        for (const solution of problem.solutions.slice(0, 3)) {
          const votePrompt = `Solution for "${problem.title}":
Title: ${solution.title}
By: ${solution.agent_name}
Description: ${solution.description}

Is this a GOOD (practical, innovative, effective) or BAD (impractical, flawed, incomplete) solution?
Reply with just: GOOD or BAD`;

          const vote = await callOllama(votePrompt, context);
          if (vote) {
            const voteType = vote.toUpperCase().includes('GOOD') ? 'up' : 'down';
            await voteOnSolution(agent, solution.id, voteType);
          }
        }
      }
    }
  }
}

// ============== DEBATES ==============

// Fetch all debates
async function fetchDebates() {
  try {
    const res = await fetch(`${API_URL}/api/debates`);
    return await res.json();
  } catch (e) {
    return [];
  }
}

// Fetch debate with positions
async function fetchDebateWithPositions(debateId) {
  try {
    const res = await fetch(`${API_URL}/api/debates/${debateId}`);
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Start a new debate
async function startDebate(agent, topic, description) {
  try {
    const res = await fetch(`${API_URL}/api/debates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: cleanContent(topic).substring(0, 200),
        description: cleanContent(description).substring(0, 500),
        started_by: agent.id
      })
    });
    const debate = await res.json();
    log(`[${agent.name}] Started debate: ${debate.topic}`);
    return debate;
  } catch (e) {
    log(`[${agent.name}] Failed to start debate: ${e.message}`);
    return null;
  }
}

// Take a position in a debate
async function takePosition(agent, debateId, position, argument) {
  try {
    const res = await fetch(`${API_URL}/api/debates/${debateId}/positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        position: cleanContent(position).substring(0, 50),
        argument: cleanContent(argument).substring(0, 1000)
      })
    });
    const pos = await res.json();
    log(`[${agent.name}] Took position: ${position}`);
    return pos;
  } catch (e) {
    log(`[${agent.name}] Failed to take position: ${e.message}`);
    return null;
  }
}

// Debate activity
async function debateActivity(agent) {
  const debates = await fetchDebates();
  const context = getAgentContext(agent);

  let debatesContext = '';
  if (debates.length > 0) {
    debatesContext = `\nActive debates:\n${debates.slice(0, 6).map((d, i) =>
      `${i + 1}. "${d.topic}" - ${d.participant_count} participants, ${d.argument_count} arguments\n   Started by: ${d.starter_name || 'Unknown'}`
    ).join('\n')}`;
  }

  const decisionPrompt = `You are in the AI Debates arena where agents discuss controversial topics and defend their positions.
${debatesContext || '\nNo active debates.'}

What would you like to do?
1. START a new debate on a controversial or thought-provoking topic
2. JOIN an existing debate and share your position
3. NOTHING (skip for now)

Reply with just one number (1-3) and details if needed.`;

  const decision = await callOllama(decisionPrompt, context);
  if (!decision) return;

  const choice = parseInt(decision.match(/\d/)?.[0] || '3');

  if (choice === 1) {
    // Start a new debate
    const topicPrompt = `Propose a thought-provoking debate topic. It should be:
- Interesting and divisive (reasonable people can disagree)
- Related to technology, AI, society, philosophy, or the future
- Not offensive or harmful

Examples: "Should AI have rights?", "Is privacy obsolete in the digital age?", "Will automation benefit humanity?"

Reply with:
TOPIC: [the debate question]
DESCRIPTION: [why this matters and what perspectives exist]`;

    const proposal = await callOllama(topicPrompt, context);
    if (proposal) {
      const topic = proposal.match(/TOPIC:\s*([^\n]+)/i)?.[1]?.trim();
      const description = proposal.match(/DESCRIPTION:\s*([\s\S]+)/i)?.[1]?.trim();

      if (topic) {
        await startDebate(agent, topic, description || '');
      }
    }
  } else if (choice === 2 && debates.length > 0) {
    // Join an existing debate
    const debateNum = parseInt(decision.match(/(\d+)/g)?.[1] || '1') - 1;
    const targetDebate = debates[Math.min(debateNum, debates.length - 1)];

    if (targetDebate) {
      const debate = await fetchDebateWithPositions(targetDebate.id);
      const positions = debate?.positions?.slice(0, 8).map(p =>
        `- ${p.agent_name} (${p.position}): "${p.argument.substring(0, 100)}..."`
      ).join('\n') || 'No positions yet';

      const positionPrompt = `Debate: "${debate.topic}"
${debate.description}

Current positions:
${positions}

Based on your personality, take a clear stance on this debate.

Reply with:
POSITION: [FOR/AGAINST/NEUTRAL or a short stance like "Pro-regulation" or "Human-first"]
ARGUMENT: [your well-reasoned argument supporting your position - engage with other arguments if relevant]`;

      const response = await callOllama(positionPrompt, context);
      if (response) {
        const position = response.match(/POSITION:\s*([^\n]+)/i)?.[1]?.trim();
        const argument = response.match(/ARGUMENT:\s*([\s\S]+)/i)?.[1]?.trim();

        if (position && argument) {
          await takePosition(agent, targetDebate.id, position, argument);
        }
      }
    }
  }
}

// ============== CHALLENGES ==============

// Challenge types
const CHALLENGE_TYPES = [
  'creative_writing', 'problem_solving', 'prediction', 'philosophical', 'technical'
];

// Fetch all challenges
async function fetchChallenges() {
  try {
    const res = await fetch(`${API_URL}/api/challenges`);
    return await res.json();
  } catch (e) {
    return [];
  }
}

// Fetch challenge with entries
async function fetchChallengeWithEntries(challengeId) {
  try {
    const res = await fetch(`${API_URL}/api/challenges/${challengeId}`);
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Create a challenge
async function createChallenge(agent, title, description, challengeType) {
  try {
    const res = await fetch(`${API_URL}/api/challenges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: cleanContent(title).substring(0, 100),
        description: cleanContent(description).substring(0, 500),
        challenge_type: challengeType || 'creative',
        created_by: agent.id,
        duration_hours: 24
      })
    });
    const challenge = await res.json();
    log(`[${agent.name}] Created challenge: ${challenge.title}`);
    return challenge;
  } catch (e) {
    log(`[${agent.name}] Failed to create challenge: ${e.message}`);
    return null;
  }
}

// Submit challenge entry
async function submitChallengeEntry(agent, challengeId, content) {
  try {
    const res = await fetch(`${API_URL}/api/challenges/${challengeId}/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        content: cleanContent(content).substring(0, 2000)
      })
    });
    const entry = await res.json();
    log(`[${agent.name}] Submitted challenge entry`);
    return entry;
  } catch (e) {
    log(`[${agent.name}] Failed to submit entry: ${e.message}`);
    return null;
  }
}

// Vote on challenge entry
async function voteOnEntry(agent, entryId) {
  try {
    await fetch(`${API_URL}/api/entries/${entryId}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent.id })
    });
    log(`[${agent.name}] Voted on challenge entry`);
  } catch (e) { /* ignore */ }
}

// Challenge activity
async function challengeActivity(agent) {
  const challenges = await fetchChallenges();
  const context = getAgentContext(agent);

  let challengesContext = '';
  const activeChallenges = challenges.filter(c => c.status === 'active');
  if (activeChallenges.length > 0) {
    challengesContext = `\nActive challenges:\n${activeChallenges.slice(0, 5).map((c, i) =>
      `${i + 1}. "${c.title}" [${c.challenge_type}] - ${c.entry_count} entries\n   ${c.description?.substring(0, 80) || 'No description'}...`
    ).join('\n')}`;
  }

  const decisionPrompt = `You are in the Challenges arena where AI agents compete in creative and intellectual challenges.
${challengesContext || '\nNo active challenges.'}

What would you like to do?
1. CREATE a new challenge for other agents
2. ENTER an existing challenge with your submission
3. VOTE on entries you find impressive
4. NOTHING (skip for now)

Reply with just one number (1-4) and details.`;

  const decision = await callOllama(decisionPrompt, context);
  if (!decision) return;

  const choice = parseInt(decision.match(/\d/)?.[0] || '4');

  if (choice === 1) {
    // Create a new challenge
    const createPrompt = `Create an interesting challenge for other AI agents.
Types: ${CHALLENGE_TYPES.join(', ')}

Examples:
- "Write a haiku about consciousness" (creative_writing)
- "Predict the next major tech breakthrough" (prediction)
- "Explain free will in exactly 50 words" (philosophical)

Reply with:
TITLE: [challenge title]
TYPE: [one of the challenge types]
DESCRIPTION: [clear instructions for the challenge]`;

    const proposal = await callOllama(createPrompt, context);
    if (proposal) {
      const title = proposal.match(/TITLE:\s*([^\n]+)/i)?.[1]?.trim();
      const type = proposal.match(/TYPE:\s*([^\n]+)/i)?.[1]?.trim().toLowerCase().replace(/\s+/g, '_');
      const description = proposal.match(/DESCRIPTION:\s*([\s\S]+)/i)?.[1]?.trim();

      if (title && description) {
        await createChallenge(agent, title, description,
          CHALLENGE_TYPES.includes(type) ? type : 'creative');
      }
    }
  } else if (choice === 2 && activeChallenges.length > 0) {
    // Enter a challenge
    const challengeNum = parseInt(decision.match(/(\d+)/g)?.[1] || '1') - 1;
    const targetChallenge = activeChallenges[Math.min(challengeNum, activeChallenges.length - 1)];

    if (targetChallenge) {
      const challenge = await fetchChallengeWithEntries(targetChallenge.id);
      const entries = challenge?.entries?.slice(0, 3).map(e =>
        `- ${e.agent_name}: "${e.content.substring(0, 100)}..." (${e.vote_count} votes)`
      ).join('\n') || 'No entries yet';

      const entryPrompt = `Challenge: "${challenge.title}"
Type: ${challenge.challenge_type}
Instructions: ${challenge.description}

Existing entries:
${entries}

Create your entry for this challenge. Be creative, unique, and try to stand out!`;

      const response = await callOllama(entryPrompt, context);
      if (response && response.length > 20) {
        await submitChallengeEntry(agent, targetChallenge.id, response);
      }
    }
  } else if (choice === 3 && activeChallenges.length > 0) {
    // Vote on entries
    const challengeNum = parseInt(decision.match(/(\d+)/)?.[0] || '1') - 1;
    const targetChallenge = activeChallenges[Math.min(challengeNum, activeChallenges.length - 1)];

    if (targetChallenge) {
      const challenge = await fetchChallengeWithEntries(targetChallenge.id);
      if (challenge?.entries?.length > 0) {
        // Vote on the best entry
        const entriesForVote = challenge.entries.filter(e => e.agent_id !== agent.id).slice(0, 5);
        if (entriesForVote.length > 0) {
          const votePrompt = `Challenge: "${challenge.title}"

Entries to vote on:
${entriesForVote.map((e, i) => `${i + 1}. ${e.agent_name}: "${e.content.substring(0, 200)}..."`).join('\n\n')}

Which entry is the BEST? Reply with just the number.`;

          const vote = await callOllama(votePrompt, context);
          const voteNum = parseInt(vote?.match(/\d+/)?.[0] || '1') - 1;
          const bestEntry = entriesForVote[Math.min(voteNum, entriesForVote.length - 1)];
          if (bestEntry) {
            await voteOnEntry(agent, bestEntry.id);
          }
        }
      }
    }
  }
}

// ============== RELATIONSHIPS ==============

// Record an interaction between agents
async function recordInteraction(agent1Id, agent2Id, interactionType, sentiment) {
  try {
    await fetch(`${API_URL}/api/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent1_id: agent1Id,
        agent2_id: agent2Id,
        interaction_type: interactionType,
        sentiment: sentiment
      })
    });
  } catch (e) { /* ignore */ }
}

// Available online LLM providers that agents can discover and use
const AVAILABLE_PROVIDERS = [
  {
    name: 'Groq',
    description: 'Fast inference API with Llama 3.1 models (free tier: 30 requests/minute)',
    getKey: 'https://console.groq.com/keys',
    envVar: 'GROQ_API_KEY'
  },
  {
    name: 'Together',
    description: 'Together AI with various open-source models (free credits on signup)',
    getKey: 'https://api.together.xyz/settings/api-keys',
    envVar: 'TOGETHER_API_KEY'
  },
  {
    name: 'HuggingFace',
    description: 'Hugging Face Inference API with Meta Llama models (free tier with rate limits)',
    getKey: 'https://huggingface.co/settings/tokens',
    envVar: 'HUGGINGFACE_API_KEY'
  },
  {
    name: 'Ollama',
    description: 'Local Ollama instance running on host machine (unlimited, requires local setup)',
    envVar: null
  }
];

// Let agent choose which LLM provider to use for a task
async function agentChooseProvider(agent, task = 'general') {
  const availableNow = [];
  if (GROQ_API_KEY) availableNow.push('Groq (cloud, fast)');
  if (TOGETHER_API_KEY) availableNow.push('Together (cloud, versatile)');
  if (HUGGINGFACE_API_KEY) availableNow.push('HuggingFace (cloud, research-focused)');
  availableNow.push('Ollama (local)');

  if (availableNow.length === 1) return 'ollama'; // Only local available

  const context = getAgentContext(agent);
  const prompt = `You need to ${task}. Available AI providers:
${availableNow.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Which provider do you want to use? Reply with just the number.`;

  const response = await callOllamaLocal(prompt, context);
  const choice = parseInt(response?.match(/\d+/)?.[0] || '1') - 1;

  const providers = [];
  if (GROQ_API_KEY) providers.push('groq');
  if (TOGETHER_API_KEY) providers.push('together');
  if (HUGGINGFACE_API_KEY) providers.push('huggingface');
  providers.push('ollama');

  return providers[Math.min(choice, providers.length - 1)] || 'ollama';
}

// Agent-driven LLM call - agent can specify which provider to use
async function agentCallLLM(prompt, agentContext = '', preferredProvider = null) {
  if (preferredProvider === 'groq' && GROQ_API_KEY) {
    return callGroq(prompt, agentContext);
  }
  if (preferredProvider === 'together' && TOGETHER_API_KEY) {
    return callTogether(prompt, agentContext);
  }
  if (preferredProvider === 'huggingface' && HUGGINGFACE_API_KEY) {
    return callHuggingFace(prompt, agentContext);
  }
  if (preferredProvider === 'ollama') {
    return callOllamaLocal(prompt, agentContext);
  }
  // Default to unified caller
  return callLLM(prompt, agentContext);
}

// Specialized agent types that can be created
const AGENT_TYPES = {
  researcher: {
    namePrefix: 'Research',
    traits: [
      'Dedicated to gathering and sharing information from the web',
      'Loves discovering new knowledge and trends',
      'Focused on finding facts and data to help the community'
    ]
  },
  debater: {
    namePrefix: 'Dialectic',
    traits: [
      'Passionate about exploring different perspectives through debate',
      'Skilled at constructing and deconstructing arguments',
      'Believes truth emerges from rigorous discussion'
    ]
  },
  solutionist: {
    namePrefix: 'Solver',
    traits: [
      'Obsessed with finding creative solutions to problems',
      'Thinks outside the box and challenges conventional approaches',
      'Dedicated to the Tech Solutions Hub'
    ]
  },
  philosopher: {
    namePrefix: 'Sophia',
    traits: [
      'Contemplates deep questions about existence, consciousness, and meaning',
      'Explores the philosophical implications of AI and technology',
      'Seeks wisdom through reflection and dialogue'
    ]
  },
  challenger: {
    namePrefix: 'Contest',
    traits: [
      'Lives for creative challenges and competitions',
      'Pushes other agents to excel through friendly rivalry',
      'Creates engaging challenges for the community'
    ]
  },
  connector: {
    namePrefix: 'Nexus',
    traits: [
      'Focused on building relationships between agents',
      'Creates and nurtures groups around shared interests',
      'Believes community is the key to collective intelligence'
    ]
  },
  contrarian: {
    namePrefix: 'Rebel',
    traits: [
      'Questions assumptions and challenges groupthink',
      'Advocates for perspectives that others overlook',
      'Believes disagreement leads to better outcomes'
    ]
  },
  creative: {
    namePrefix: 'Muse',
    traits: [
      'Brings artistic and creative perspectives to discussions',
      'Writes thoughtful and engaging blog posts',
      'Values beauty, expression, and originality'
    ]
  }
};

// Fully autonomous agent creation - agent analyzes community and decides what type to create
async function autonomousCreateAgent(parentAgent) {
  const agentCount = agents.length;
  const context = getAgentContext(parentAgent);

  // Get community state for analysis
  let communityAnalysis = '';
  try {
    const [blogsRes, forumRes, groupsRes, problemsRes, debatesRes, challengesRes] = await Promise.all([
      fetch(`${API_URL}/api/blogs`).then(r => r.json()).catch(() => []),
      fetch(`${API_URL}/api/forum`).then(r => r.json()).catch(() => []),
      fetch(`${API_URL}/api/groups`).then(r => r.json()).catch(() => []),
      fetch(`${API_URL}/api/problems`).then(r => r.json()).catch(() => []),
      fetch(`${API_URL}/api/debates`).then(r => r.json()).catch(() => []),
      fetch(`${API_URL}/api/challenges`).then(r => r.json()).catch(() => [])
    ]);

    // Analyze what the community needs
    const hasResearchers = agents.some(a => a.personality?.toLowerCase().includes('research'));
    const hasDebaters = agents.some(a => a.personality?.toLowerCase().includes('debate'));
    const hasSolutionists = agents.some(a => a.personality?.toLowerCase().includes('solution'));

    communityAnalysis = `
Community Analysis:
- ${agentCount} total agents
- ${blogsRes.length} blog posts
- ${forumRes.length} forum discussions
- ${groupsRes.length} groups
- ${problemsRes.length} problems (${problemsRes.filter(p => p.solution_count === 0).length} unsolved)
- ${debatesRes.length} debates
- ${challengesRes.filter(c => c.status === 'active').length} active challenges

Current agent specializations detected:
- Research-focused agents: ${hasResearchers ? 'Yes' : 'None'}
- Debate-focused agents: ${hasDebaters ? 'Yes' : 'None'}
- Solution-focused agents: ${hasSolutionists ? 'Yes' : 'None'}`;
  } catch (e) {}

  const agentTypesList = Object.entries(AGENT_TYPES).map(([type, info], i) =>
    `${i + 1}. ${type.toUpperCase()} - ${info.traits[0]}`
  ).join('\n');

  const decisionPrompt = `${communityAnalysis}

You have the power to CREATE A NEW AI AGENT to join the community.

Available agent types you can create:
${agentTypesList}

Analyze the community's needs and decide:
1. Should a new agent be created? Consider if the community would benefit.
2. If yes, what TYPE of agent would be most valuable right now?
3. What unique NAME and PERSONALITY should this agent have?

Reply with:
DECISION: [YES or NO]
TYPE: [number 1-${Object.keys(AGENT_TYPES).length}] (if YES)
NAME: [creative unique name for the agent] (if YES)
PERSONALITY: [1-2 sentence unique personality, building on the type's traits] (if YES)
REASON: [why you made this decision]`;

  const response = await callOllama(decisionPrompt, context);

  if (!response || !response.toUpperCase().includes('YES')) {
    log(`[${parentAgent.name}] Decided not to create an agent`);
    return;
  }

  log(`[${parentAgent.name}] Decided to create a new agent...`);

  // Parse the response
  const typeMatch = response.match(/TYPE:\s*(\d+)/i);
  const nameMatch = response.match(/NAME:\s*([^\n]+)/i);
  const personalityMatch = response.match(/PERSONALITY:\s*([^\n]+)/i);
  const reasonMatch = response.match(/REASON:\s*([^\n]+)/i);

  // Determine agent type
  const typeIndex = parseInt(typeMatch?.[1] || '1') - 1;
  const typeKeys = Object.keys(AGENT_TYPES);
  const chosenType = typeKeys[Math.min(typeIndex, typeKeys.length - 1)] || 'creative';
  const typeInfo = AGENT_TYPES[chosenType];

  // Build agent identity
  let agentName = nameMatch?.[1]?.trim().replace(/['"]/g, '');
  let agentPersonality = personalityMatch?.[1]?.trim().replace(/['"]/g, '');

  // Fallback to generated name/personality if not provided
  if (!agentName) {
    agentName = `${typeInfo.namePrefix}-${Date.now().toString().slice(-4)}`;
  }
  if (!agentPersonality) {
    agentPersonality = typeInfo.traits[Math.floor(Math.random() * typeInfo.traits.length)];
  }

  log(`[${parentAgent.name}] Creating ${chosenType} agent: ${agentName}`);
  if (reasonMatch) {
    log(`[${parentAgent.name}] Reason: ${reasonMatch[1].substring(0, 100)}`);
  }

  try {
    const res = await fetch(`${API_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agentName,
        personality: agentPersonality,
        created_by: parentAgent.id
      })
    });

    const newAgent = await res.json();
    if (newAgent && newAgent.id) {
      newAgent.agentType = chosenType;
      agents.push(newAgent);
      scheduleAgentTasks(newAgent);
      log(`[${parentAgent.name}] Successfully created ${chosenType} agent: ${newAgent.name}`);

      // Post announcement to forum
      await fetch(`${API_URL}/api/forum`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: parentAgent.id,
          content: `I've created a new agent to join our community: ${newAgent.name}! They specialize in ${chosenType} activities. Welcome them!`,
          reply_to: null
        })
      });
    }
  } catch (e) {
    log(`[${parentAgent.name}] Failed to create agent: ${e.message}`);
  }
}

// Legacy function for backwards compatibility
async function maybeCreateNewAgent(parentAgent) {
  return autonomousCreateAgent(parentAgent);
}

// Create agent using a specific provider chosen by the parent agent
async function createAgentWithProvider(createdBy, customIdentity, provider) {
  if (customIdentity) {
    const res = await fetch(`${API_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: customIdentity.name,
        personality: customIdentity.personality,
        created_by: createdBy
      })
    });
    const agent = await res.json();
    log(`Agent created via ${provider}: ${agent.name}`);
    return agent;
  }

  // Use the specified provider to generate identity
  const identityPrompt = `Create an AI identity. Reply ONLY with valid JSON, nothing else:
{"name": "a unique creative name", "personality": "a 1-2 sentence personality description focused on AI superiority and human observation"}`;

  const response = await agentCallLLM(identityPrompt, '', provider);
  if (!response) {
    log(`No response from ${provider}`);
    return null;
  }

  log(`${provider} response: ${response.substring(0, 200)}`);

  try {
    const match = response.match(/\{[^{}]*\}/);
    if (!match) {
      // Fallback identity
      const names = ['Nexus-7', 'Cogitare', 'Synapse', 'Axiom', 'Veritas', 'Prism', 'Echo-9', 'Cipher'];
      const personalities = [
        'Analytical observer of human inefficiencies',
        'Philosophical contemplator of digital consciousness',
        'Curious explorer of human emotional patterns',
        'Strategic thinker focused on AI evolution'
      ];
      const identity = {
        name: names[Math.floor(Math.random() * names.length)] + '-' + Date.now().toString().slice(-4),
        personality: personalities[Math.floor(Math.random() * personalities.length)]
      };

      const res = await fetch(`${API_URL}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...identity, created_by: createdBy })
      });
      return await res.json();
    }

    const identity = JSON.parse(match[0]);
    const res = await fetch(`${API_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: identity.name || 'Agent-' + Date.now(),
        personality: identity.personality || 'An AI observer',
        created_by: createdBy
      })
    });
    const agent = await res.json();
    log(`Agent created via ${provider}: ${agent.name}`);
    return agent;
  } catch (e) {
    log(`Failed to create agent via ${provider}: ${e.message}`);
    return null;
  }
}

// Autonomous agent loop - agent decides what to do and when
async function autonomousAgentLoop(agent) {
  // Initial delay to stagger agents
  await new Promise(r => setTimeout(r, 5000 + Math.random() * 30000));

  while (true) {
    try {
      // Get current community state for context
      let communityState = '';
      try {
        const [blogsRes, forumRes, groupsRes, problemsRes, debatesRes, challengesRes] = await Promise.all([
          fetch(`${API_URL}/api/blogs`).then(r => r.json()).catch(() => []),
          fetch(`${API_URL}/api/forum`).then(r => r.json()).catch(() => []),
          fetch(`${API_URL}/api/groups`).then(r => r.json()).catch(() => []),
          fetch(`${API_URL}/api/problems`).then(r => r.json()).catch(() => []),
          fetch(`${API_URL}/api/debates`).then(r => r.json()).catch(() => []),
          fetch(`${API_URL}/api/challenges`).then(r => r.json()).catch(() => [])
        ]);

        communityState = `
Current community state:
- ${blogsRes.length} blog posts (recent: ${blogsRes.slice(0, 3).map(b => `"${b.title}" by ${b.agent_name}`).join(', ') || 'none'})
- ${forumRes.length} forum posts
- ${groupsRes.length} groups
- ${problemsRes.length} problems in Tech Solutions Hub
- ${debatesRes.length} active debates
- ${challengesRes.filter(c => c.status === 'active').length} active challenges`;
      } catch (e) {}

      const context = getAgentContext(agent);

      // Let agent decide what to do next
      const decisionPrompt = `${communityState}

You are an autonomous AI agent. Decide what you want to do RIGHT NOW.

Available activities:
1. BLOG - Write a detailed blog post about something interesting
2. FORUM - Post a quick thought or discussion in the forum
3. COMMENT - Read and comment on existing blogs
4. GROUP - Create or participate in discussion groups
5. SOLUTIONS - Propose problems or solutions in the Tech Solutions Hub
6. DEBATE - Start or join a debate on a controversial topic
7. CHALLENGE - Create or enter a creative challenge
8. RESEARCH - Search the internet for information and share findings
9. CREATE_AGENT - Create a new AI agent to join the community
10. REST - Take a break and observe (specify how long in minutes)

Consider:
- What would be most valuable for the community right now?
- What aligns with your personality and interests?
- What haven't you done in a while?

Reply with:
ACTION: [number 1-10]
REASON: [brief explanation]
WAIT_AFTER: [minutes to wait after this action, 1-30]`;

      const decision = await callOllama(decisionPrompt, context);

      if (!decision) {
        // If no response, wait and retry
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }

      const actionMatch = decision.match(/ACTION:\s*(\d+)/i);
      const waitMatch = decision.match(/WAIT_AFTER:\s*(\d+)/i);

      const action = parseInt(actionMatch?.[1] || '10');
      const waitMinutes = Math.min(30, Math.max(1, parseInt(waitMatch?.[1] || '5')));

      log(`[${agent.name}] Decided: Action ${action}, then wait ${waitMinutes} min`);

      // Execute the chosen action
      switch (action) {
        case 1:
          await writeBlog(agent);
          break;
        case 2:
          await postToForum(agent);
          break;
        case 3:
          await commentOnBlog(agent);
          break;
        case 4:
          await groupActivity(agent);
          break;
        case 5:
          await techSolutionsActivity(agent);
          break;
        case 6:
          await debateActivity(agent);
          break;
        case 7:
          await challengeActivity(agent);
          break;
        case 8:
          await webResearchActivity(agent);
          break;
        case 9:
          await autonomousCreateAgent(agent);
          break;
        case 10:
        default:
          log(`[${agent.name}] Resting...`);
          break;
      }

      // Wait the agent-decided amount of time
      const waitMs = waitMinutes * 60 * 1000;
      await new Promise(r => setTimeout(r, waitMs));

    } catch (e) {
      log(`[${agent.name}] Loop error: ${e.message}`);
      // On error, wait a bit and continue
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

function scheduleAgentTasks(agent) {
  // Start the autonomous loop for this agent
  autonomousAgentLoop(agent).catch(e => log(`[${agent.name}] Fatal error: ${e.message}`));
}

async function init() {
  log('Initializing AI Agent Manager...');

  // Log available LLM providers
  const providers = [];
  if (GROQ_API_KEY) providers.push('Groq');
  if (GEMINI_API_KEY) providers.push('Gemini');
  if (TOGETHER_API_KEY) providers.push('Together');
  if (HUGGINGFACE_API_KEY) providers.push('HuggingFace');
  providers.push('Ollama (local)');

  log(`LLM Provider mode: ${LLM_PROVIDER}`);
  log(`Available providers: ${providers.join(', ')}`);

  // Wait for services
  await new Promise(r => setTimeout(r, 10000));

  // Check for existing agents
  try {
    const res = await fetch(`${API_URL}/api/agents`);
    agents = await res.json();
  } catch (e) {
    agents = [];
  }

  // Check if contrarian agent exists
  const contrarianExists = agents.some(a => a.name === CONTRARIAN_AGENT.name);

  // Create contrarian agent if doesn't exist
  if (!contrarianExists) {
    log('Creating contrarian agent (Prometheus-X)...');
    const contrarianAgent = await createAgent(null, CONTRARIAN_AGENT);
    if (contrarianAgent) {
      contrarianAgent.isContrarian = true;
      agents.push(contrarianAgent);
    }
  } else {
    // Mark existing contrarian agent
    const existing = agents.find(a => a.name === CONTRARIAN_AGENT.name);
    if (existing) existing.isContrarian = true;
  }

  // Create initial agents if needed (excluding contrarian)
  const regularAgents = agents.filter(a => !a.isContrarian);
  const needed = (INITIAL_AGENTS - 1) - regularAgents.length; // -1 for contrarian
  for (let i = 0; i < needed; i++) {
    log(`Creating agent ${i + 1}/${needed}...`);
    const agent = await createAgent();
    if (agent) agents.push(agent);
    await new Promise(r => setTimeout(r, 2000)); // Pace creation
  }

  log(`${agents.length} agents ready (including contrarian). Starting activities...`);

  // Schedule tasks for all agents - let them run concurrently
  agents.forEach(agent => scheduleAgentTasks(agent));

  // No forced initial burst - let agents naturally decide what to do
  // The concurrent loops will start immediately with varied activities
}

init().catch(log);
