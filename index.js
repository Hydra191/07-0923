'use strict';

const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'flange.db');

// 允许的螺栓数：偶数，4 至 24
const ALLOWED_BOLT_COUNTS = Array.from({ length: 11 }, (_, i) => 4 + i * 2);

// ---------- 紧固序列 ----------
// 自 1 号螺栓起，按相邻位次相差 bolt_count / 2 对径交替：
// 1, 1+h, 2, 2+h, ...（h = bolt_count / 2）
function buildSequence(boltCount) {
  const half = boltCount / 2;
  const sequence = [];
  for (let i = 1; i <= half; i++) {
    sequence.push(i);
    sequence.push(i + half);
  }
  return sequence;
}

// ---------- 请求校验 ----------
function validate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: '请求体必须为 JSON 对象' };
  }

  const { dn, bolt_count: boltCount, target_torque: targetTorque, stages } = body;

  if (dn === undefined || dn === null || dn === '') {
    return { ok: false, reason: '缺少 dn' };
  }
  const dnStr = String(dn).trim();
  if (!dnStr) {
    return { ok: false, reason: 'dn 不能为空字符串' };
  }

  if (!ALLOWED_BOLT_COUNTS.includes(boltCount)) {
    return {
      ok: false,
      reason: `bolt_count 必须为偶数且在 4 至 24 之间，收到 ${JSON.stringify(boltCount)}`,
    };
  }

  if (typeof targetTorque !== 'number' || !Number.isFinite(targetTorque) || targetTorque <= 0) {
    return {
      ok: false,
      reason: `target_torque 必须为正数 (N·m)，收到 ${JSON.stringify(targetTorque)}`,
    };
  }

  if (!Array.isArray(stages) || stages.length === 0) {
    return { ok: false, reason: 'stages 必须为非空数组' };
  }
  for (const s of stages) {
    if (typeof s !== 'number' || !Number.isFinite(s)) {
      return { ok: false, reason: `stages 元素必须为数字，发现 ${JSON.stringify(s)}` };
    }
    if (s <= 0) {
      return { ok: false, reason: `stages 比例必须为正数，发现 ${s}` };
    }
  }
  for (let i = 1; i < stages.length; i++) {
    if (!(stages[i] > stages[i - 1])) {
      return {
        ok: false,
        reason: `stages 必须严格递增：${stages[i - 1]} 之后不能为 ${stages[i]}`,
      };
    }
  }
  if (stages[stages.length - 1] !== 100) {
    return {
      ok: false,
      reason: `stages 末项必须为 100，收到 ${stages[stages.length - 1]}`,
    };
  }

  return {
    ok: true,
    value: { dn: dnStr, boltCount, targetTorque, stages: stages.slice() },
  };
}

// 生成完整方案：逐级逐颗返回紧固序号与扭矩（四舍五入到 1 N·m）
function buildPlan({ boltCount, targetTorque, stages }) {
  const sequence = buildSequence(boltCount);
  const plan = [];
  stages.forEach((percent, stageIndex) => {
    const torque = Math.round((percent / 100) * targetTorque);
    sequence.forEach((boltNo, orderIndex) => {
      plan.push({
        stage: stageIndex + 1,
        stage_percent: percent,
        order: stageIndex * boltCount + orderIndex + 1,
        bolt_no: boltNo,
        torque_nm: torque,
      });
    });
  });
  return plan;
}

// ---------- 数据库 ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS flange_schemes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dn            TEXT    NOT NULL,
    bolt_count    INTEGER NOT NULL,
    target_torque REAL    NOT NULL,
    stages        TEXT    NOT NULL,
    sequence      TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (dn, bolt_count)
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO flange_schemes (dn, bolt_count, target_torque, stages, sequence)
  VALUES (@dn, @bolt_count, @target_torque, @stages, @sequence)
  ON CONFLICT (dn, bolt_count) DO UPDATE SET
    target_torque = excluded.target_torque,
    stages        = excluded.stages,
    sequence      = excluded.sequence,
    created_at    = datetime('now')
`);

const selectStmt = db.prepare(`
  SELECT * FROM flange_schemes WHERE dn = ? AND bolt_count = ?
`);

// ---------- HTTP ----------
const app = express();
app.use(express.json());

// 生成并落库
app.post('/api/v1/flange/torque', (req, res) => {
  const result = validate(req.body);
  if (!result.ok) {
    return res.status(400).json({ ok: false, reason: result.reason });
  }

  const { dn, boltCount, targetTorque, stages } = result.value;
  const sequence = buildSequence(boltCount);
  const plan = buildPlan({ boltCount, targetTorque, stages });

  upsertStmt.run({
    dn,
    bolt_count: boltCount,
    target_torque: targetTorque,
    stages: JSON.stringify(stages),
    sequence: JSON.stringify(sequence),
  });

  return res.status(201).json({
    ok: true,
    dn,
    bolt_count: boltCount,
    target_torque_nm: targetTorque,
    stages,
    tightening_sequence: sequence,
    steps: plan,
  });
});

// 按 dn 与螺栓数反查同一序列
app.get('/api/v1/flange/scheme', (req, res) => {
  const { dn, bolt_count: rawBoltCount } = req.query;

  if (dn === undefined || dn === null || String(dn).trim() === '') {
    return res.status(400).json({ ok: false, reason: '缺少查询参数 dn' });
  }
  const dnStr = String(dn).trim();

  const boltCount = Number(rawBoltCount);
  if (!ALLOWED_BOLT_COUNTS.includes(boltCount)) {
    return res
      .status(400)
      .json({ ok: false, reason: '查询参数 bolt_count 必须为偶数且在 4 至 24 之间' });
  }

  const row = selectStmt.get(dnStr, boltCount);
  if (!row) {
    return res.status(404).json({
      ok: false,
      reason: `未找到 dn=${dnStr}、螺栓数=${boltCount} 的方案`,
    });
  }

  const stages = JSON.parse(row.stages);
  const sequence = JSON.parse(row.sequence);
  const steps = buildPlan({
    boltCount: row.bolt_count,
    targetTorque: row.target_torque,
    stages,
  });

  return res.json({
    ok: true,
    dn: row.dn,
    bolt_count: row.bolt_count,
    target_torque_nm: row.target_torque,
    stages,
    tightening_sequence: sequence,
    steps,
    created_at: row.created_at,
  });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, reason: '请求体不是合法 JSON' });
  }
  console.error(err);
  return res.status(500).json({ ok: false, reason: '服务器内部错误' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`flange torque service listening on http://localhost:${PORT}`);
  });
}

module.exports = { app, buildSequence, validate, buildPlan };
