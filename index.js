'use strict';

const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_BOLT_COUNTS = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24];

// 对径交替（星形）紧固次序：1, 1+n/2, 2, 2+n/2, ...
function boltOrder(boltCount) {
  const half = boltCount / 2;
  const order = [];
  for (let i = 1; i <= half; i++) {
    order.push(i, i + half);
  }
  return order;
}

// 逐级逐颗生成紧固步骤：分级扭矩 = 比例 × 目标扭矩，四舍五入到 1 N·m
function buildSteps(boltCount, targetTorque, percents) {
  const order = boltOrder(boltCount);
  const steps = [];
  let seq = 1;
  percents.forEach((percent, stageIndex) => {
    const torque = Math.round((percent / 100) * targetTorque);
    for (const bolt of order) {
      steps.push({
        stage: stageIndex + 1,
        percent,
        seq: seq++,
        bolt,
        torque,
      });
    }
  });
  return steps;
}

// 校验入参，失败返回 { error: 原因 }，成功返回 null
function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体须为 JSON 对象' };
  }

  const { dn, bolt_count, target_torque, stages } = body;

  if (typeof dn !== 'string' || dn.trim() === '') {
    return { error: 'dn 须为非空字符串' };
  }

  if (!ALLOWED_BOLT_COUNTS.includes(bolt_count)) {
    return { error: `螺栓数须为偶数且取值于 ${ALLOWED_BOLT_COUNTS.join('、')}` };
  }

  if (typeof target_torque !== 'number' || !Number.isFinite(target_torque) || target_torque <= 0) {
    return { error: '目标扭矩须为正数（N·m）' };
  }

  if (!Array.isArray(stages) || stages.length === 0) {
    return { error: 'stages 须为非空数组（分级比例，末项为 100）' };
  }
  if (!stages.every((p) => typeof p === 'number' && Number.isFinite(p))) {
    return { error: '分级比例须全部为数值' };
  }
  for (let i = 1; i < stages.length; i++) {
    if (!(stages[i] > stages[i - 1])) {
      return { error: '分级比例须严格递增' };
    }
  }
  if (stages[stages.length - 1] !== 100) {
    return { error: '分级比例末项须为 100' };
  }

  return null;
}

function createApp(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS flange_scheme (
      dn            TEXT    NOT NULL,
      bolt_count    INTEGER NOT NULL,
      target_torque REAL    NOT NULL,
      stages        TEXT    NOT NULL,
      payload       TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (dn, bolt_count)
    )
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO flange_scheme (dn, bolt_count, target_torque, stages, payload, created_at)
    VALUES (@dn, @bolt_count, @target_torque, @stages, @payload, @created_at)
    ON CONFLICT(dn, bolt_count) DO UPDATE SET
      target_torque = excluded.target_torque,
      stages        = excluded.stages,
      payload       = excluded.payload,
      created_at    = excluded.created_at
  `);
  const selectStmt = db.prepare(
    'SELECT payload FROM flange_scheme WHERE dn = ? AND bolt_count = ?'
  );

  const app = express();
  app.use(express.json());

  app.post('/api/v1/flange/torque', (req, res) => {
    const error = validateInput(req.body);
    if (error) {
      return res.status(400).json(error); // 校验失败不落库
    }

    const { dn } = req.body;
    const boltCount = req.body.bolt_count;
    const targetTorque = req.body.target_torque;
    const stages = req.body.stages;

    const payload = {
      dn: dn.trim(),
      bolt_count: boltCount,
      target_torque: targetTorque,
      stages,
      steps: buildSteps(boltCount, targetTorque, stages),
    };

    upsertStmt.run({
      dn: payload.dn,
      bolt_count: boltCount,
      target_torque: targetTorque,
      stages: JSON.stringify(stages),
      payload: JSON.stringify(payload),
      created_at: Date.now(),
    });

    res.status(201).json(payload);
  });

  app.get('/api/v1/flange/scheme', (req, res) => {
    const dn = typeof req.query.dn === 'string' ? req.query.dn.trim() : '';
    const boltCount = Number(req.query.bolt_count);

    if (!dn) {
      return res.status(400).json({ error: '查询参数 dn 必填' });
    }
    if (!ALLOWED_BOLT_COUNTS.includes(boltCount)) {
      return res
        .status(400)
        .json({ error: `查询参数 bolt_count 须取值于 ${ALLOWED_BOLT_COUNTS.join('、')}` });
    }

    const row = selectStmt.get(dn, boltCount);
    if (!row) {
      return res.status(404).json({ error: `未找到 dn=${dn}、螺栓数=${boltCount} 的紧固方案` });
    }
    res.json(JSON.parse(row.payload));
  });

  // JSON 解析失败（请求体非法）统一返回 400
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求体不是合法 JSON' });
    }
    next(err);
  });

  app.use((req, res) => res.status(404).json({ error: '未找到该接口' }));

  return { app, db };
}

if (require.main === module) {
  const { app } = createApp(path.join(__dirname, 'flange.db'));
  app.listen(PORT, () => {
    console.log(`flange torque service listening on http://localhost:${PORT}`);
  });
}

module.exports = { createApp, buildSteps, boltOrder, validateInput, ALLOWED_BOLT_COUNTS };
