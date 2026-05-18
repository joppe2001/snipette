import log from 'electron-log';
import type {
  CaptionSegment,
  JlptLevel,
  OllamaModel,
  TranslateOpts,
  TranslateProgress,
  TranslationMood,
} from '../../shared/types';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

/** Language-to-default-model map. Adding a new language is a single entry. */
const DEFAULT_MODEL_BY_LANG: Record<string, string> = {
  ja: 'schroneko/llama-3.1-swallow-8b-instruct-v0.1:q4_k_m',
};

/** Hard fallback when no language-specific model is configured. Multilingual + small. */
const FALLBACK_MULTILINGUAL_MODEL = 'qwen2.5:14b-instruct';

/** How many segments to translate in a single LLM call. Higher = fewer round-trips but
 *  more risk the model drops or merges entries. 8 lands well empirically. */
const BATCH_SIZE = 8;

let cancelled = false;

export function cancelTranslation(): void {
  cancelled = true;
}

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listOllamaModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!res.ok) throw new Error(`Ollama list models failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as {
    models: Array<{
      name: string;
      size: number;
      details?: { parameter_size?: string; family?: string };
    }>;
  };
  return (body.models ?? []).map((m) => ({
    name: m.name,
    size: m.size,
    parameter_size: m.details?.parameter_size,
    family: m.details?.family,
  }));
}

/** Resolve the model to use given user opts + the default map. */
function resolveModel(opts: TranslateOpts): string {
  if (opts.model) return opts.model;
  return DEFAULT_MODEL_BY_LANG[opts.targetLang] ?? FALLBACK_MULTILINGUAL_MODEL;
}

/** ISO 639-1 → human language name. Models follow "Japanese" far better than "ja". */
const LANG_NAMES: Record<string, string> = {
  ja: 'Japanese',
  es: 'Spanish',
  ko: 'Korean',
  zh: 'Chinese',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
};

/** JLPT-level → guidance, written in Japanese because Swallow is Japanese-tuned and
 *  follows Japanese instructions far more reliably than English ones for output style. */
const JLPT_GUIDANCE_JA: Record<JlptLevel, string> = {
  N5: 'JLPT N5レベル相当。初級者向け。基本的な漢字のみ使用し、難しい語彙は避ける。「です・ます」体で簡潔に。',
  N4: 'JLPT N4レベル相当。初級〜初中級。常用漢字の基礎範囲内。シンプルな文法（て形・たい・てから等）。',
  N3: 'JLPT N3レベル相当。中級。自然な常用漢字を使い、丁寧体と普通体を文脈に応じて使い分ける。',
  N2: 'JLPT N2レベル相当。中上級。自然な口語・書き言葉。慣用表現や中頻度の漢字も使用可。',
  N1: 'JLPT N1レベル相当。上級〜ネイティブ。豊富な語彙と慣用表現、適切な敬語・くだけた表現を文脈に合わせて使用。',
};

/** JLPT guidance for non-Japanese targets stays in English. */
const JLPT_GUIDANCE_EN: Record<JlptLevel, string> = {
  N5: 'Beginner Japanese — basic grammar and kanji only.',
  N4: 'Elementary Japanese — first 300 Joyo kanji, simple connective grammar.',
  N3: 'Intermediate Japanese — natural mix of polite/plain forms.',
  N2: 'Upper-intermediate Japanese — natural register, common idioms.',
  N1: 'Advanced native-feeling Japanese — rich vocabulary, appropriate keigo.',
};

/** Mood guidance written in Japanese for Swallow. Maps the four-step register dial onto
 *  concrete grammatical features so the model has something specific to follow. */
const MOOD_GUIDANCE_JA: Record<TranslationMood, string> = {
  casual:
    'カジュアル（タメ口）。友達同士の会話のように、普通体（だ・である調ではなく、「〜だよ」「〜だね」「〜じゃん」などの口語）を使う。文末は短く砕けた表現にする。',
  polite:
    '丁寧体（です・ます調）。一般的な動画字幕に適した、自然で礼儀正しい話し方。過度な敬語は使わない。',
  formal:
    'フォーマルな書き言葉寄りの口調。ニュース・ナレーション向けの落ち着いた表現。「〜です・〜ます」を基本としつつ、語彙はやや硬めに。',
  keigo:
    '敬語を必ず使用すること。単なる丁寧語（です・ます）ではなく、尊敬語と謙譲語の専用動詞を能動的に使う：相手の動作には「いらっしゃる」「ご覧になる」「召し上がる」「おっしゃる」、自分の動作には「伺う」「拝見する」「申し上げる」「いたします」「させていただく」。名詞には「お／ご」を付ける（例：お会い、ご協力）。ビジネスや接客のような最上位の敬意表現にすること。',
};

/** Mood guidance for non-Japanese targets stays in English. */
const MOOD_GUIDANCE_EN: Record<TranslationMood, string> = {
  casual: 'Casual register — relaxed conversational tone, contractions allowed.',
  polite: 'Polite register — standard polite spoken language suitable for most video captions.',
  formal: 'Formal register — slightly elevated vocabulary, news or narration style.',
  keigo: 'Highly formal honorific register — business or customer-service style.',
};

function systemPrompt(targetLang: string, jlpt?: JlptLevel, mood?: TranslationMood): string {
  const targetName = LANG_NAMES[targetLang] ?? targetLang;
  const m: TranslationMood = mood ?? 'polite';
  // Swallow is tuned for Japanese — brief it in Japanese for better adherence.
  if (targetLang === 'ja') {
    const level = jlpt ? JLPT_GUIDANCE_JA[jlpt] : JLPT_GUIDANCE_JA.N3;
    const moodLine = MOOD_GUIDANCE_JA[m];
    return `あなたは動画字幕の翻訳者です。入力された英文を、自然で読みやすい日本語に翻訳してください。

レベル: ${level}
口調: ${moodLine}

【絶対に守るルール】
1. 出力は必ず日本語のみ（漢字・ひらがな・カタカナ）。英語は一切含めない。
2. 出力形式は JSON 配列のみ。文字列の配列を返す。オブジェクトや連想配列は禁止。
3. 入力の配列と完全に同じ順序・同じ長さ。
4. ローマ字、注釈、解説、マークダウンは禁止。
5. 指定された口調を全ての出力で一貫して使うこと。

【出力例】
入力: ["I have a meeting tomorrow.", "I was free."]
出力: ["明日、会議があります。", "暇でした。"]`;
  }
  const level = jlpt ? `\nLevel: ${JLPT_GUIDANCE_EN[jlpt]}` : '';
  const moodLine = `\nRegister: ${MOOD_GUIDANCE_EN[m]}`;
  return `You are a translator for short-form video captions. Translate every input string into ${targetName}.${level}${moodLine}

Strict rules:
1. Output ONLY a JSON array of ${targetName} strings — never an object, never a dict, never prose.
2. Same order and length as the input array.
3. Natural spoken ${targetName} suitable for on-screen captions.
4. No romanisation, no notes, no markdown fences.
5. Apply the chosen register consistently across every output.`;
}

/** Strip ```json fences, leading prose, etc. Returns the inner JSON or throws. */
function extractJsonArray(raw: string): string {
  const trimmed = raw.trim();
  // Common case: model returns pure JSON.
  if (trimmed.startsWith('[')) return trimmed;
  // Fenced code block.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  // Look for first [ and last ].
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error(`Model output is not a JSON array: ${raw.slice(0, 200)}`);
}

/** True if the string contains at least one Japanese script char. Used to detect when a
 *  model returns a {translation: source} dict, so we pick the JA side, not the EN side. */
function looksJapanese(s: string): boolean {
  // Hiragana, Katakana, CJK unified ideographs.
  return /[぀-ゟ゠-ヿ一-鿿]/.test(s);
}

/** True if the string is dominantly ASCII letters (i.e. probably English). */
function looksEnglish(s: string): boolean {
  const letters = s.match(/[A-Za-z]/g)?.length ?? 0;
  return letters > 0 && letters >= s.replace(/\s/g, '').length * 0.6;
}

function inferTargetScriptCheck(targetLang: string): (s: string) => boolean {
  if (targetLang === 'ja') return looksJapanese;
  // Fallback: just require non-empty. Add more language detectors as needed.
  return (s) => s.trim().length > 0;
}

/** Pull a string array out of arbitrary model output. Handles:
 *  - plain JSON array
 *  - JSON object that wraps an array under translations/result/output/etc.
 *  - JSON object that maps translation→source (or source→translation). The script-check
 *    callback decides which side is the actual translation for this language. */
function parseToArray(
  raw: string,
  expectedLen: number,
  isTargetScript: (s: string) => boolean,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(extractJsonArray(raw));
  }
  if (Array.isArray(parsed)) {
    if (parsed.length !== expectedLen) {
      throw new Error(`Got array of length ${parsed.length}, expected ${expectedLen}`);
    }
    return parsed.map((v) => String(v ?? '').trim());
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Model output is neither an array nor an object');
  }
  const obj = parsed as Record<string, unknown>;
  // Common wrapper keys first.
  for (const key of ['translations', 'result', 'output', 'data', 'items']) {
    const v = obj[key];
    if (Array.isArray(v) && v.length === expectedLen) {
      return v.map((x) => String(x ?? '').trim());
    }
  }
  // Dict-mapping case: pick the side whose values look like the target script.
  const entries = Object.entries(obj);
  if (entries.length === expectedLen) {
    const keys = entries.map(([k]) => k);
    const values = entries.map(([, v]) => String(v ?? '').trim());
    const keysInTarget = keys.filter(isTargetScript).length;
    const valuesInTarget = values.filter(isTargetScript).length;
    if (keysInTarget >= valuesInTarget && keysInTarget > 0) return keys;
    if (valuesInTarget > 0) return values;
  }
  throw new Error('Model returned an object we could not coerce into a translation array');
}

async function translateBatch(
  batch: string[],
  opts: TranslateOpts,
  model: string,
): Promise<string[]> {
  const targetName = LANG_NAMES[opts.targetLang] ?? opts.targetLang;
  const userContent =
    opts.targetLang === 'ja'
      ? `次の英文配列を日本語に翻訳してください。出力は同じ長さの JSON 配列のみ。オブジェクトや解説は不要。\n\n${JSON.stringify(batch)}`
      : `Translate this JSON array into ${targetName}. Reply with a JSON array of strings only — same order, same length.\n\n${JSON.stringify(batch)}`;
  // NOTE: deliberately NOT passing format: 'json' — Ollama's JSON-mode forces models
  // into object schemas, and quantised Llama variants like Swallow default to
  // {translation: source} dicts under that pressure. Letting the model emit a plain
  // JSON array via the prompt alone produces much cleaner results.
  const payload = {
    model,
    stream: false,
    options: { temperature: 0.2 },
    messages: [
      { role: 'system', content: systemPrompt(opts.targetLang, opts.jlptLevel, opts.mood) },
      { role: 'user', content: userContent },
    ],
  };
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Ollama chat failed: ${res.status} ${res.statusText} ${errText.slice(0, 200)}`);
  }
  const body = (await res.json()) as { message?: { content?: string } };
  const content = body.message?.content ?? '';
  log.debug(`ollama[${model}] → ${content.slice(0, 400)}`);
  const isTargetScript = inferTargetScriptCheck(opts.targetLang);
  const out = parseToArray(content, batch.length, isTargetScript);
  // Hard sanity check for Japanese: if more than half the entries are still English,
  // the model didn't actually translate. Throw so the caller retries one-by-one.
  if (opts.targetLang === 'ja') {
    const englishCount = out.filter((s) => looksEnglish(s)).length;
    if (englishCount > out.length / 2) {
      throw new Error('Model output is still English — retrying with a tighter prompt');
    }
  }
  return out;
}

/** Translate one segment at a time. Used as a fallback when a batch parse fails so
 *  the user doesn't lose the whole job to one malformed response. */
async function translateOneByOne(
  batch: string[],
  opts: TranslateOpts,
  model: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const item of batch) {
    if (cancelled) throw new Error('Translation cancelled');
    try {
      const [translated] = await translateBatch([item], opts, model);
      out.push(translated);
    } catch (e) {
      log.warn('ollama: single-segment translate failed, preserving source', e);
      out.push(item);
    }
  }
  return out;
}

export async function translateSegments(
  segments: CaptionSegment[],
  opts: TranslateOpts,
  onProgress: (p: TranslateProgress) => void,
): Promise<CaptionSegment[]> {
  cancelled = false;
  const model = resolveModel(opts);
  log.info(`ollama: translating ${segments.length} segments to ${opts.targetLang} with ${model}`);

  const result: CaptionSegment[] = segments.map((s) => ({
    ...s,
    translations: { ...(s.translations ?? {}) },
  }));

  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    if (cancelled) throw new Error('Translation cancelled');
    const slice = segments.slice(i, i + BATCH_SIZE);
    const texts = slice.map((s) => s.text);

    let translated: string[];
    try {
      translated = await translateBatch(texts, opts, model);
    } catch (e) {
      log.warn(`ollama: batch ${i / BATCH_SIZE} failed, retrying segment-by-segment`, e);
      translated = await translateOneByOne(texts, opts, model);
    }

    for (let j = 0; j < slice.length; j += 1) {
      const target = result[i + j];
      target.translations = { ...target.translations, [opts.targetLang]: translated[j] };
    }
    onProgress({
      percent: Math.round(((i + slice.length) / segments.length) * 100),
      segmentIndex: i + slice.length,
      segmentCount: segments.length,
    });
  }
  return result;
}
