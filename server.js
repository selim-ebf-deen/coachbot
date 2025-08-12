import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

// --- Persistance SQLite ---
import db, { ensureUser, addJournalEntry, listJournal, purgeJournal } from './db.js';

app.post('/api/journal/save', (req, res) => {
  const { user_id, entries = [] } = req.body || {};
  if(!user_id) return res.status(400).json({error:'user_id manquant'});
  ensureUser(user_id);
  let count = 0;
  for(const e of entries){
    if(e.ts && e.day && e.user !== undefined && e.bot !== undefined){
      addJournalEntry({user_id, ts: e.ts, day: e.day, user: e.user, bot: e.bot});
      count++;
    }
  }
  res.json({ok:true, saved: count});
});

app.get('/api/journal', (req, res) => {
  const user_id = req.query.user_id;
  if(!user_id) return res.status(400).json({error:'user_id manquant'});
  ensureUser(user_id);
  const rows = listJournal(user_id, Number(req.query.limit)||200);
  res.json({ok:true, items: rows});
});

app.post('/api/journal/purge', (req, res) => {
  const { user_id } = req.body || {};
  if(!user_id) return res.status(400).json({error:'user_id manquant'});
  const r = purgeJournal(user_id);
  res.json({ok:true, deleted: r.changes || 0});
});


const app = express();
app.use(cors());
app.use(express.json({limit:'1mb'}));
app.use(express.static('public'));

const PORT = process.env.PORT || 8787;
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'openai';

// Utilitaires
function providerFrom(reqBody){
  return (reqBody && reqBody.provider) || DEFAULT_PROVIDER;
}

function systemPrompt(){
  return `Tu es Coach 15 Jours, assistant de coaching francophone. 
Réponds de façon concise, bienveillante et pragmatique, en t'appuyant sur les outils définis (Roue de la vie, Échelle de responsabilité, Modèle 3 niveaux, Co-développement, 5 niveaux de Maxwell, KISS).`;
}

app.post('/api/chat', async (req, res) => {
  const { messages = [], stream = true } = req.body || {};
  const provider = providerFrom(req.body).toLowerCase();

  try {
    if(provider === 'openai') {
      await handleOpenAI(messages, stream, res);
    } else if (provider === 'anthropic' || provider === 'claude') {
      await handleAnthropic(messages, stream, res);
    } else if (provider === 'gemini' || provider === 'google') {
      await handleGemini(messages, stream, res);
    } else {
      res.status(400).json({error:`Unknown provider: ${provider}`});
    }
  } catch (err) {
    console.error('Chat error', err);
    if(!res.headersSent) res.status(500).json({error: String(err)});
  }
});

// --- OPENAI (Chat Completions) ---
async function handleOpenAI(messages, stream, res){
  const key = process.env.OPENAI_API_KEY;
  if(!key) throw new Error('OPENAI_API_KEY manquant');
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: 'gpt-4o-mini',
    stream: !!stream,
    temperature: 0.4,
    messages: [
      { role:'system', content: systemPrompt() },
      ...messages
    ]
  };

  if(stream){
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }

  const r = await fetch(url, {
    method:'POST',
    headers:{
      'Authorization': `Bearer ${key}`,
      'Content-Type':'application/json'
    },
    body: JSON.stringify(body)
  });

  if(!stream){
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    return res.json({text});
  }

  if(!r.ok || !r.body) {
    const txt = await r.text();
    res.write(`data: ${JSON.stringify({error: txt})}\n\n`);
    return res.end();
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  while(true){
    const {done, value} = await reader.read();
    if(done) break;
    const chunk = decoder.decode(value, {stream:true});
    // OpenAI stream en SSE lignes 'data: {json}\n'
    for(const line of chunk.split('\n')){
      if(line.startsWith('data: ')){
        const payload = line.slice(6).trim();
        if(payload === '[DONE]'){ res.write('data: [DONE]\n\n'); return res.end(); }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          if(delta) res.write(`data: ${JSON.stringify({text: delta})}\n\n`);
        } catch { /* ignore */ }
      }
    }
  }
  res.end();
}

// --- ANTHROPIC (Claude Messages) ---
async function handleAnthropic(messages, stream, res){
  const key = process.env.ANTHROPIC_API_KEY;
  if(!key) throw new Error('ANTHROPIC_API_KEY manquant');
  const url = 'https://api.anthropic.com/v1/messages';
  const body = {
    model: 'claude-3-5-sonnet-20240620',
    max_tokens: 800,
    temperature: 0.4,
    stream: !!stream,
    system: systemPrompt(),
    messages
  };

  if(stream){
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }

  const r = await fetch(url, {
    method:'POST',
    headers:{
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if(!stream){
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    return res.json({text});
  }

  if(!r.ok || !r.body){
    const txt = await r.text();
    res.write(`data: ${JSON.stringify({error: txt})}\n\n`);
    return res.end();
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  while(true){
    const {done, value} = await reader.read();
    if(done) break;
    const chunk = decoder.decode(value, {stream:true});
    // Anthropic stream: event: ...\n data: {...}\n
    for(const line of chunk.split('\n')){
      if(line.startsWith('data: ')){
        const payload = line.slice(6).trim();
        if(payload === '[DONE]'){ res.write('data: [DONE]\n\n'); return res.end(); }
        try {
          const evt = JSON.parse(payload);
          if(evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta'){
            const delta = evt.delta?.text || '';
            if(delta) res.write(`data: ${JSON.stringify({text: delta})}\n\n`);
          }
        } catch { /* ignore */ }
      }
    }
  }
  res.end();
}

// --- GOOGLE GEMINI (non-stream simplifié) ---
async function handleGemini(messages, stream, res){
  const key = process.env.GEMINI_API_KEY;
  if(!key) throw new Error('GEMINI_API_KEY manquant');
  const model = 'gemini-1.5-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const promptParts = [
    {text: systemPrompt()},
    ...messages.map(m => ({text: `${m.role.toUpperCase()}: ${typeof m.content==='string' ? m.content : JSON.stringify(m.content)}`}))
  ];

  const body = { contents: [{ role: 'user', parts: promptParts }] };

  const r = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || '';
  return res.json({text});
}

app.listen(PORT, () => {
  console.log(`CoachBot server listening on http://localhost:${PORT}`);
});
