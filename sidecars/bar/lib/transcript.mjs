import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const ID_RE = /^[0-9a-f-]{8,}$/i;
export const FIXED_LIMIT_TOKENS = 262_144; // Antigravity 2.0 ~256K auto-compaction threshold

/**
 * Locate the Antigravity app data directories containing a `brain/` folder.
 * When launched by Antigravity, derives the exact appData dir from
 * `ANTIGRAVITY_EXECUTABLE_DATA_DIR`; otherwise falls back to `~/.gemini/*`.
 */
export function findAppDataDirs(env = process.env) {
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  try {
    return readdirSync(root)
      .sort()
      .map((name) => join(root, name))
      .filter((dir) => existsSync(join(dir, 'brain')));
  } catch {
    return [];
  }
}

export function resolveTranscriptFile(convId, env = process.env) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appData of findAppDataDirs(env)) {
    const candidate = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(candidate)) {
      return { appData, path: candidate };
    }
  }
  return null;
}

export function safeStat(filePath) {
  try {
    const s = statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function toNonNegInt(val) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * Extract clean user prompt text from `USER_INPUT.content`, stripping
 * `<USER_REQUEST>` wrappers and injected metadata tags.
 */
export function extractPromptText(content) {
  const raw = String(content || '');
  const reqMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  const extracted = reqMatch
    ? reqMatch[1]
    : raw
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '');
  const full = extracted.trim();
  const oneLine = full.replace(/\s+/g, ' ');
  const preview = oneLine.length > 96 ? `${oneLine.slice(0, 95)}…` : oneLine;
  return { full, preview };
}

/**
 * Classify whether the first model invocation after a user prompt was a cold
 * start, partial cache hit, or warm/hot start.
 */
export function classifyStartup(firstCall, turnIndex) {
  if (!firstCall) {
    return { kind: 'pending', label: '等待响应', hitRate: 0 };
  }
  const hitRate = firstCall.cacheHitRate;
  if (firstCall.cacheReadTokens === 0 || hitRate < 0.25) {
    return {
      kind: 'cold',
      label: turnIndex === 1 ? '冷启动 · 首轮' : '冷启动 · 缓存未命中',
      hitRate,
    };
  }
  if (hitRate < 0.7) {
    return {
      kind: 'partial',
      label: '部分缓存',
      hitRate,
    };
  }
  return {
    kind: 'warm',
    label: '热启动',
    hitRate,
  };
}

/**
 * Parse a `transcript.jsonl` string into token/context metrics and per-prompt turns.
 * Tolerates partial/incomplete trailing lines while a conversation is actively streaming.
 */
export function parseTranscriptText(text) {
  const lines = String(text || '').split('\n');
  let totalSteps = 0;
  let sumInput = 0;
  let sumCacheRead = 0;
  let sumOutput = 0;
  const modelSteps = [];
  const turns = [];
  let activeTurn = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    totalSteps += 1;

    if (entry?.type === 'USER_INPUT') {
      const { full, preview } = extractPromptText(entry.content);
      activeTurn = {
        turnIndex: turns.length + 1,
        stepIndex: Number.isFinite(Number(entry.step_index)) ? Number(entry.step_index) : totalSteps - 1,
        createdAt: typeof entry.created_at === 'string' ? entry.created_at : '',
        promptPreview: preview || '（空 Prompt）',
        promptFull: full,
        calls: [],
        turnInputTokens: 0,
        turnOutputTokens: 0,
      };
      turns.push(activeTurn);
      continue;
    }

    const hasTokenFields =
      entry?.input_tokens !== undefined ||
      entry?.cache_read_tokens !== undefined ||
      entry?.output_tokens !== undefined;

    // 关键修正：仅包含 Token 统计字段，或者为真正的模型响应（PLANNER_RESPONSE）时，才计入模型生成步。
    // 严禁将工具调用返回/命令输出（source: 'MODEL', type: 'GENERIC'）纳入模型步，否则 0 Token 结果会冲垮 contextUsed 与 cacheHitRate！
    const isPlannerResponse = entry?.type === 'PLANNER_RESPONSE';

    if (!hasTokenFields && !isPlannerResponse) continue;

    const inputTokens = toNonNegInt(entry.input_tokens);
    const cacheReadTokens = toNonNegInt(entry.cache_read_tokens);
    const outputTokens = toNonNegInt(entry.output_tokens);
    const contextUsed = inputTokens + cacheReadTokens;

    sumInput += inputTokens;
    sumCacheRead += cacheReadTokens;
    sumOutput += outputTokens;

    const stepRecord = {
      stepIndex: Number.isFinite(Number(entry.step_index)) ? Number(entry.step_index) : totalSteps - 1,
      createdAt: typeof entry.created_at === 'string' ? entry.created_at : '',
      inputTokens,
      cacheReadTokens,
      outputTokens,
      contextUsed,
      cacheHitRate: contextUsed > 0 ? cacheReadTokens / contextUsed : 0,
    };
    modelSteps.push(stepRecord);

    if (!activeTurn) {
      activeTurn = {
        turnIndex: turns.length + 1,
        stepIndex: stepRecord.stepIndex,
        createdAt: stepRecord.createdAt,
        promptPreview: '（会话初始指令）',
        promptFull: '',
        calls: [],
        turnInputTokens: 0,
        turnOutputTokens: 0,
      };
      turns.push(activeTurn);
    }
    activeTurn.calls.push(stepRecord);
    activeTurn.turnInputTokens += inputTokens;
    activeTurn.turnOutputTokens += outputTokens;
  }

  let prevTurnEndContext = 0;
  const summarizedTurns = turns.map((t) => {
    const firstCall = t.calls[0] || null;
    const lastCall = t.calls.length > 0 ? t.calls[t.calls.length - 1] : null;
    const endContext = lastCall ? lastCall.contextUsed : prevTurnEndContext;
    const turnDelta = lastCall ? endContext - prevTurnEndContext : 0;
    if (lastCall) prevTurnEndContext = endContext;

    return {
      turnIndex: t.turnIndex,
      stepIndex: t.stepIndex,
      createdAt: t.createdAt,
      promptPreview: t.promptPreview,
      promptFull: t.promptFull,
      modelCalls: t.calls.length,
      startup: classifyStartup(firstCall, t.turnIndex),
      firstCall: firstCall
        ? {
            inputTokens: firstCall.inputTokens,
            cacheReadTokens: firstCall.cacheReadTokens,
            contextUsed: firstCall.contextUsed,
            cacheHitRate: firstCall.cacheHitRate,
          }
        : null,
      endContextUsed: lastCall ? lastCall.contextUsed : null,
      turnDelta,
      turnInputTokens: t.turnInputTokens,
      turnOutputTokens: t.turnOutputTokens,
      callStepIndices: t.calls.map((c) => c.stepIndex),
    };
  });

  const latestRaw = modelSteps.length > 0 ? modelSteps[modelSteps.length - 1] : null;
  const latest = latestRaw
    ? {
        ...latestRaw,
        projectedNextMin: latestRaw.contextUsed + latestRaw.outputTokens,
      }
    : null;

  const totalPromptTokens = sumInput + sumCacheRead;

  return {
    totalSteps,
    modelCalls: modelSteps.length,
    turnCount: summarizedTurns.length,
    latest,
    totals: {
      inputTokens: sumInput,
      cacheReadTokens: sumCacheRead,
      outputTokens: sumOutput,
      totalPromptTokens,
      avgCacheHitRate: totalPromptTokens > 0 ? sumCacheRead / totalPromptTokens : 0,
    },
    series: modelSteps.slice(-60).map((s) => ({
      stepIndex: s.stepIndex,
      contextUsed: s.contextUsed,
      cacheReadTokens: s.cacheReadTokens,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
    })),
    recentTurns: summarizedTurns.slice(-20).reverse(),
  };
}

export function parseDurationSec(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  const s = String(raw).trim();
  const m = s.match(/^(-?\d+(?:\.\d+)?)s$/i);
  const n = m ? Number(m[1]) : Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const MIN_STREAMING_SEC_FOR_TPS = 0.02;
const MIN_SUSTAINED_STREAMING_SEC = 0.5;
const MAX_REALISTIC_TPS = 320;

/**
 * Build a Map<stepIndex, speedEntry> from LanguageServerService
 * `GetCascadeTrajectoryGeneratorMetadata` entries.
 */
export function buildSpeedIndex(generatorMetadata) {
  const index = new Map();
  if (!Array.isArray(generatorMetadata)) return index;
  for (const row of generatorMetadata) {
    const cm = row?.chatModel;
    const stepIndices = Array.isArray(row?.stepIndices) ? row.stepIndices : [];
    if (!cm || stepIndices.length === 0) continue;

    const ttftSec = parseDurationSec(cm.timeToFirstToken);
    const streamingSec = parseDurationSec(cm.streamingDuration);
    const durationSec =
      ttftSec !== null && streamingSec !== null
        ? ttftSec + streamingSec
        : (ttftSec ?? streamingSec ?? null);
    const outputTokens = toNonNegInt(cm.usage?.outputTokens);
    const thinkingTokens = toNonNegInt(cm.usage?.thinkingOutputTokens);
    const responseOutputTokens = toNonNegInt(cm.usage?.responseOutputTokens);
    const inputTokens = toNonNegInt(cm.usage?.inputTokens);
    const cacheReadTokens = toNonNegInt(cm.usage?.cacheReadTokens);
    const contextUsed = inputTokens + cacheReadTokens;
    const cacheHitRate = contextUsed > 0 ? cacheReadTokens / contextUsed : 0;

    if (outputTokens <= 0) continue;

    // 原始流式生成速率
    const rawStreamingTps =
      streamingSec !== null && streamingSec >= MIN_STREAMING_SEC_FOR_TPS
        ? outputTokens / streamingSec
        : null;

    // 完整生成总耗时吞吐速率
    const totalTps =
      durationSec !== null && durationSec > 0
        ? Number((outputTokens / durationSec).toFixed(1))
        : null;

    // 校准后 TPS：
    // 只有在持续流式输出（>= 0.5s）且物理速率合理（<= 320 tok/s）时，采纳纯流速；
    // 对于短工具调用、思考突发或 TCP 缓冲单次冲刷（秒数极小导致上千 tok/s），平滑回退至整步吞吐速率，杜绝 6000+ 畸高值
    let calibratedTps = null;
    let sustainedStreamingTps = null;

    if (rawStreamingTps !== null && streamingSec >= MIN_SUSTAINED_STREAMING_SEC && rawStreamingTps <= MAX_REALISTIC_TPS) {
      sustainedStreamingTps = Number(rawStreamingTps.toFixed(1));
      calibratedTps = sustainedStreamingTps;
    } else if (totalTps !== null && totalTps > 0) {
      calibratedTps = Math.min(MAX_REALISTIC_TPS, totalTps);
    } else if (rawStreamingTps !== null) {
      calibratedTps = Math.min(MAX_REALISTIC_TPS, Number(rawStreamingTps.toFixed(1)));
    }

    const entry = {
      ttftSec: ttftSec !== null ? Number(ttftSec.toFixed(2)) : null,
      streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
      durationSec: durationSec !== null ? Number(durationSec.toFixed(2)) : null,
      outputTokens,
      thinkingTokens,
      responseOutputTokens,
      inputTokens,
      cacheReadTokens,
      contextUsed,
      cacheHitRate,
      streamingTps: sustainedStreamingTps,
      rawStreamingTps: rawStreamingTps !== null ? Number(rawStreamingTps.toFixed(1)) : null,
      durationTps: totalTps,
      tps: calibratedTps,
      calibratedTps,
      model: cm.responseModel || cm.model || '',
    };

    for (const idx of stepIndices) {
      const stepNum = Number(idx);
      if (Number.isFinite(stepNum)) {
        index.set(stepNum, entry);
      }
    }
  }
  return index;
}

/**
 * Enrich a parsed transcript summary with TTFT and TPS metrics from `speedIndex`.
 */
export function enrichSummaryWithSpeed(summary, speedIndex) {
  if (!summary || !(speedIndex instanceof Map) || speedIndex.size === 0) {
    return summary;
  }

  let latest = summary.latest;
  if (latest) {
    let sp = speedIndex.get(latest.stepIndex) || null;
    if (!sp || (sp.outputTokens === 0 && !sp.tps)) {
      // latest 可能是无 chatModel metadata 的步骤（如纯工具输出）：
      // 向前回溯最近一个有有效测速数据的主模型调用，避免 TPS/TTFT 误显示为空
      for (let i = summary.series.length - 1; i >= 0; i--) {
        const cand = speedIndex.get(summary.series[i].stepIndex);
        if (cand && (cand.outputTokens > 0 || cand.tps !== null)) {
          sp = cand;
          break;
        }
      }
      if (!sp && speedIndex.size > 0) {
        // 全局兜底：从 speedIndex 倒序寻找步数最大且有有效测速的记录
        const sorted = [...speedIndex.entries()].sort((a, b) => b[0] - a[0]);
        for (const [, cand] of sorted) {
          if (cand && (cand.outputTokens > 0 || cand.tps !== null)) {
            sp = cand;
            break;
          }
        }
        if (!sp && sorted.length > 0) sp = sorted[0][1];
      }
    }
    // 兜底补齐：若 transcript 缺少 token 字段导致 contextUsed 为 0，而 LS 元数据中有真实使用量，自动补齐
    if (latest.contextUsed === 0 && sp && sp.contextUsed > 0) {
      latest.contextUsed = sp.contextUsed;
      latest.inputTokens = sp.inputTokens;
      latest.cacheReadTokens = sp.cacheReadTokens;
      latest.cacheHitRate = sp.cacheHitRate;
      latest.projectedNextMin = latest.contextUsed + (latest.outputTokens || sp.outputTokens);
    }
    latest = sp ? { ...latest, speed: sp } : latest;
  } else if (speedIndex.size > 0) {
    // summary.latest 原本为 null（例如 transcript 缺少 token 字段）时的兜底合成
    const sorted = [...speedIndex.entries()].sort((a, b) => b[0] - a[0]);
    for (const [stepNum, sp] of sorted) {
      if (sp && (sp.outputTokens > 0 || sp.tps !== null)) {
        latest = {
          stepIndex: stepNum,
          contextUsed: sp.contextUsed || 0,
          inputTokens: sp.inputTokens || 0,
          outputTokens: sp.outputTokens,
          cacheReadTokens: sp.cacheReadTokens || 0,
          cacheHitRate: sp.cacheHitRate || 0,
          speed: sp,
        };
        break;
      }
    }
  }

  const recentTurns = (summary.recentTurns || []).map((t) => {
    const stepIndices = Array.isArray(t.callStepIndices) ? t.callStepIndices : [];
    const seenEntries = new Set();
    const entries = [];
    for (const idx of stepIndices) {
      const e = speedIndex.get(idx);
      if (e && !seenEntries.has(e)) {
        seenEntries.add(e);
        entries.push(e);
      }
    }
    if (entries.length === 0) return t;

    const firstEntry = entries[0];
    let sumStreamOut = 0;
    let sumStreamSec = 0;
    let sumTotalOut = 0;
    let sumTotalSec = 0;
    for (const e of entries) {
      if (e.outputTokens > 0 && e.streamingSec !== null && e.streamingSec >= MIN_SUSTAINED_STREAMING_SEC) {
        sumStreamOut += e.outputTokens;
        sumStreamSec += e.streamingSec;
      }
      if (e.outputTokens > 0 && e.durationSec !== null && e.durationSec > 0) {
        sumTotalOut += e.outputTokens;
        sumTotalSec += e.durationSec;
      }
    }

    const sustainedStreamTps = (sumStreamSec >= MIN_SUSTAINED_STREAMING_SEC && (sumStreamOut / sumStreamSec) <= MAX_REALISTIC_TPS)
      ? Number((sumStreamOut / sumStreamSec).toFixed(1))
      : null;
    const turnTotalTps = sumTotalSec > 0 ? Number((sumTotalOut / sumTotalSec).toFixed(1)) : null;
    const turnCalibratedTps = sustainedStreamTps ?? (turnTotalTps !== null ? Math.min(MAX_REALISTIC_TPS, turnTotalTps) : null);

    return {
      ...t,
      speed: {
        ttftSec: firstEntry.ttftSec,
        streamingTps: sustainedStreamTps,
        tps: turnCalibratedTps,
        durationSec: sumTotalSec > 0 ? Number(sumTotalSec.toFixed(2)) : null,
        model: firstEntry.model || '',
      },
    };
  });

  // Session-wide weighted averages across unique generator entries
  const uniqueAll = new Set(speedIndex.values());
  let ttftSum = 0;
  let ttftCount = 0;
  let streamOutSum = 0;
  let streamSecSum = 0;
  const modelsSet = new Set();
  for (const e of uniqueAll) {
    if (e.model) modelsSet.add(e.model);
    if (e.ttftSec !== null) {
      ttftSum += e.ttftSec;
      ttftCount += 1;
    }
    if (e.outputTokens > 0 && e.streamingSec !== null && e.streamingSec >= MIN_SUSTAINED_STREAMING_SEC && (e.outputTokens / e.streamingSec) <= MAX_REALISTIC_TPS) {
      streamOutSum += e.outputTokens;
      streamSecSum += e.streamingSec;
    }
  }

  return {
    ...summary,
    latest,
    recentTurns,
    speedStats: {
      avgTtftSec: ttftCount > 0 ? Number((ttftSum / ttftCount).toFixed(2)) : null,
      avgStreamingTps: streamSecSum > 0 ? Number((streamOutSum / streamSecSum).toFixed(1)) : null,
      sampleCount: uniqueAll.size,
      models: [...modelsSet],
    },
  };
}

export function readTranscriptFile(filePath) {
  return readFileSync(filePath, 'utf-8');
}

function toLocalDateKey(isoStr) {
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysLocal(date, delta) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
  return d;
}

/**
 * Find all `brain/` directories across Antigravity desktop and CLI (`~/.gemini/<app>/brain`).
 */
export function findAllBrainDirs(env = process.env) {
  const dirs = new Set();
  const dataDir = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const b = join(dirname(d), 'brain');
      if (existsSync(b)) dirs.add(b);
      break;
    }
  }
  const root = join(homedir(), '.gemini');
  try {
    for (const name of readdirSync(root).sort()) {
      const b = join(root, name, 'brain');
      if (existsSync(b)) dirs.add(b);
    }
  } catch {
    // Ignore missing ~/.gemini
  }
  return [...dirs];
}

/**
 * Aggregate a single `transcript.jsonl` into per-local-day token buckets.
 */
export function parseTranscriptDaily(text) {
  const byDay = new Map();
  const lines = String(text || '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type !== 'PLANNER_RESPONSE') continue;
    const dateKey = toLocalDateKey(obj.created_at);
    if (!dateKey) continue;

    const inputTokens = toNonNegInt(obj.input_tokens);
    const cacheReadTokens = toNonNegInt(obj.cache_read_tokens);
    const outputTokens = toNonNegInt(obj.output_tokens);
    const totalTokens = inputTokens + cacheReadTokens + outputTokens;

    let bucket = byDay.get(dateKey);
    if (!bucket) {
      bucket = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, stepTokens: [] };
      byDay.set(dateKey, bucket);
    }
    bucket.inputTokens += inputTokens;
    bucket.cacheReadTokens += cacheReadTokens;
    bucket.outputTokens += outputTokens;
    bucket.totalTokens += totalTokens;
    bucket.calls += 1;
    if (obj.step_index != null) {
      bucket.stepTokens.push({ stepIndex: Number(obj.step_index), totalTokens });
    }
  }
  return byDay;
}

/**
 * Build a N-week GitHub-style activity heatmap from per-conversation daily maps.
 */
export function buildHeatmapData(entries, { weeks = 16, now = new Date() } = {}) {
  const clampedWeeks = Math.min(52, Math.max(4, Math.round(Number(weeks) || 16)));
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = toLocalDateKey(todayLocal.toISOString());

  // Monday = 0 .. Sunday = 6
  const dow = (todayLocal.getDay() + 6) % 7;
  const currentMonday = addDaysLocal(todayLocal, -dow);
  const startDate = addDaysLocal(currentMonday, -(clampedWeeks - 1) * 7);
  const endDate = addDaysLocal(currentMonday, 6);

  const dayMap = new Map();
  for (let i = 0; i < clampedWeeks * 7; i++) {
    const d = addDaysLocal(startDate, i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dayMap.set(key, {
      date: key,
      month: d.getMonth() + 1,
      dayOfMonth: d.getDate(),
      isToday: key === todayKey,
      isFuture: d > todayLocal,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      calls: 0,
      sessions: new Set(),
    });
  }

  const allSessions = new Set();
  for (const entry of entries || []) {
    if (!entry?.dailyMap) continue;
    for (const [dateKey, b] of entry.dailyMap.entries()) {
      const cell = dayMap.get(dateKey);
      if (!cell || cell.isFuture) continue;
      cell.totalTokens += b.totalTokens;
      cell.inputTokens += b.inputTokens;
      cell.cacheReadTokens += b.cacheReadTokens;
      cell.outputTokens += b.outputTokens;
      cell.calls += b.calls;
      if (entry.convId) {
        cell.sessions.add(entry.convId);
        allSessions.add(entry.convId);
      }
    }
  }

  let maxDayTokens = 0;
  let sumTotal = 0;
  let sumInput = 0;
  let sumCache = 0;
  let sumOutput = 0;
  let sumCalls = 0;
  let activeDays = 0;

  for (const cell of dayMap.values()) {
    if (cell.totalTokens > maxDayTokens) maxDayTokens = cell.totalTokens;
    if (cell.totalTokens > 0 || cell.calls > 0) activeDays += 1;
    sumTotal += cell.totalTokens;
    sumInput += cell.inputTokens;
    sumCache += cell.cacheReadTokens;
    sumOutput += cell.outputTokens;
    sumCalls += cell.calls;
  }

  const days = [...dayMap.values()].map((cell) => {
    let level = 0;
    if (cell.totalTokens > 0 && maxDayTokens > 0) {
      const ratio = cell.totalTokens / maxDayTokens;
      if (ratio >= 0.75) level = 4;
      else if (ratio >= 0.45) level = 3;
      else if (ratio >= 0.18) level = 2;
      else level = 1;
    }
    return {
      date: cell.date,
      month: cell.month,
      dayOfMonth: cell.dayOfMonth,
      isToday: cell.isToday,
      isFuture: cell.isFuture,
      totalTokens: cell.totalTokens,
      inputTokens: cell.inputTokens,
      cacheReadTokens: cell.cacheReadTokens,
      outputTokens: cell.outputTokens,
      calls: cell.calls,
      sessions: cell.sessions.size,
      sessionIds: [...cell.sessions],
      level,
    };
  });

  return {
    weeks: clampedWeeks,
    rangeStart: days[0]?.date || '',
    rangeEnd: todayKey,
    maxDayTokens,
    totals: {
      totalTokens: sumTotal,
      inputTokens: sumInput,
      cacheReadTokens: sumCache,
      outputTokens: sumOutput,
      calls: sumCalls,
      activeDays,
      sessions: allSessions.size,
    },
    days,
  };
}
