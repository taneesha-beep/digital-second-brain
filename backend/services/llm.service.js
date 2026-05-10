const Groq = require('groq-sdk');

const PROMPTS = {
  summarize:
    'Summarize the following notes in 4-5 clear sentences highlighting the main ideas. Write in plain prose, no bullet points.',
  flashcards:
    'Generate 6 flashcard Q&A pairs from these notes. Return ONLY a valid JSON array — no markdown, no code fences, no explanation, nothing else. Format exactly: [{"q":"question","a":"answer"}]',
  concepts:
    'Extract 8 key concepts from these notes. Return ONLY a valid JSON array — no markdown, no code fences, no explanation, nothing else. Format exactly: [{"term":"term","definition":"one sentence definition"}]',
  examQs:
    'Generate 5 exam-style questions with detailed answers from these notes. Return ONLY a valid JSON array — no markdown, no code fences, no explanation, nothing else. Format exactly: [{"question":"q","answer":"a"}]',
  eli5:
    'Explain the following notes as if explaining to a 12-year-old. Use simple words, short sentences, and fun analogies. No jargon.'
};

// Groq free models — llama-3 is fast and high quality
const MODEL = 'llama-3.3-70b-versatile';

exports.processNote = async (contentText, feature) => {
  const API_KEY = process.env.GROQ_API_KEY;
  if (!API_KEY) {
    throw new Error(
      'Missing GROQ_API_KEY — add it to backend/.env and restart the server. ' +
      'Get a free key at console.groq.com'
    );
  }

  const prompt = PROMPTS[feature];
  if (!prompt) {
    throw new Error(
      `Unknown feature: "${feature}". Valid: summarize, flashcards, concepts, examQs, eli5`
    );
  }

  const groq = new Groq({ apiKey: API_KEY });

  try {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful study assistant. Follow the user instructions exactly. ' +
            'When asked for JSON, return ONLY the JSON array — no extra text, no markdown fences.'
        },
        {
          role: 'user',
          content: `${prompt}\n\nNotes:\n${contentText}`
        }
      ],
      temperature: 0.4,
      max_tokens: 1024
    });

    const text = completion.choices?.[0]?.message?.content || '';

    // Strip markdown fences if the model wrapped JSON output anyway
    if (['flashcards', 'concepts', 'examQs'].includes(feature)) {
      return text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    }

    return text;
  } catch (err) {
    const msg = String(err.message || '');

    if (msg.includes('401') || msg.includes('invalid_api_key')) {
      throw new Error('Invalid Groq API key — check GROQ_API_KEY in your .env file');
    }
    if (msg.includes('429') || msg.includes('rate_limit')) {
      throw new Error('Groq rate limit hit — wait a few seconds and try again');
    }
    if (msg.includes('503') || msg.includes('unavailable')) {
      throw new Error('Groq service temporarily unavailable — try again in a moment');
    }

    throw new Error(`AI processing failed: ${msg}`);
  }
};