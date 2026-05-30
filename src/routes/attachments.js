const express = require('express');
const router  = express.Router();
const db      = require('../../config/database');
const logger  = require('../utils/logger');

router.get('/types', async (req, res) => {
  try {
    const rows = await db.manyOrNone(`
      SELECT sensor_type,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status='ACTIVE') AS active,
             COUNT(*) FILTER (WHERE status='FAULTY') AS faulty
      FROM smart_city_attachments
      GROUP BY sensor_type ORDER BY total DESC
    `);
    res.json({ ok:true, sensor_types:rows });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/:id/history', async (req, res) => {
  const { from, to, limit=500 } = req.query;
  const fromTs = from ? new Date(from) : new Date(Date.now()-3600*1000);
  const toTs   = to   ? new Date(to)   : new Date();
  try {
    const rows = await db.manyOrNone(`
      SELECT timestamp, raw_data_payload, ingest_latency_ms
      FROM attachment_telemetry
      WHERE attachment_id=$1 AND timestamp BETWEEN $2 AND $3
      ORDER BY timestamp DESC LIMIT $4
    `, [req.params.id, fromTs, toTs, parseInt(limit)]);
    res.json({ ok:true, attachment_id:parseInt(req.params.id), count:rows.length, data:rows });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const a = await db.oneOrNone(`
      SELECT a.*, p.pole_number, p.road_name,
             w.ward_number, w.secretariat_code, z.zone_name
      FROM smart_city_attachments a
      JOIN poles p ON a.pole_id=p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      JOIN wards w ON jb.ward_id=w.ward_id
      JOIN zones z ON w.zone_id=z.zone_id
      WHERE a.attachment_id=$1
    `, [req.params.id]);
    if (!a) return res.status(404).json({ ok:false, error:'Attachment not found' });

    const recent = await db.manyOrNone(`
      SELECT timestamp, raw_data_payload
      FROM attachment_telemetry WHERE attachment_id=$1
      ORDER BY timestamp DESC LIMIT 5
    `, [req.params.id]);

    res.json({ ok:true, data:a, recent_payloads:recent });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.get('/', async (req, res) => {
  const { sensor_type, status, page=1, limit=100 } = req.query;
  const offset=(parseInt(page)-1)*parseInt(limit);
  const params=[], where=[];
  if (sensor_type) { params.push(sensor_type); where.push(`a.sensor_type=$${params.length}`); }
  if (status)      { params.push(status);       where.push(`a.status=$${params.length}`); }
  const whereClause = where.length ? 'WHERE '+where.join(' AND ') : '';

  try {
    params.push(parseInt(limit), offset);
    const rows = await db.manyOrNone(`
      SELECT a.attachment_id, a.sensor_type, a.manufacturer_id, a.model_number,
             a.firmware_version, a.status, a.commissioning_date,
             p.pole_number, p.road_name, z.zone_name
      FROM smart_city_attachments a
      JOIN poles p ON a.pole_id=p.pole_id
      JOIN junction_boxes jb ON p.cabinet_id=jb.cabinet_id
      JOIN wards w ON jb.ward_id=w.ward_id
      JOIN zones z ON w.zone_id=z.zone_id
      ${whereClause}
      ORDER BY a.attachment_id DESC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);
    res.json({ ok:true, count:rows.length, data:rows });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.post('/', async (req, res) => {
  const { pole_id, sensor_type, manufacturer_id, model_number, firmware_version, mac_address, config_json } = req.body;
  if (!pole_id || !sensor_type) return res.status(400).json({ ok:false, error:'pole_id and sensor_type required' });

  try {
    const pole = await db.oneOrNone('SELECT pole_id, pole_number FROM poles WHERE pole_id=$1', [pole_id]);
    if (!pole) return res.status(404).json({ ok:false, error:`Pole ${pole_id} not found` });

    const a = await db.one(`
      INSERT INTO smart_city_attachments
        (pole_id, sensor_type, manufacturer_id, model_number, firmware_version, mac_address, commissioning_date, config_json)
      VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7) RETURNING *
    `, [pole_id, sensor_type.toUpperCase(), manufacturer_id||null, model_number||null,
        firmware_version||null, mac_address||null, config_json?JSON.stringify(config_json):null]);

    logger.info('Sensor registered', { attachment_id:a.attachment_id, sensor_type:a.sensor_type });
    res.status(201).json({ ok:true, data:a });
  } catch(err) {
    if (err.code==='23505') return res.status(409).json({ ok:false, error:'MAC address already registered' });
    res.status(500).json({ ok:false, error:'Internal server error' });
  }
});

router.patch('/:id/status', async (req, res) => {
  const valid = ['ACTIVE','INACTIVE','FAULTY','DECOMMISSIONED'];
  if (!valid.includes(req.body.status)) return res.status(400).json({ ok:false, error:`status must be: ${valid.join(', ')}` });
  try {
    const row = await db.oneOrNone(`
      UPDATE smart_city_attachments SET status=$1 WHERE attachment_id=$2 RETURNING *
    `, [req.body.status, req.params.id]);
    if (!row) return res.status(404).json({ ok:false, error:'Attachment not found' });
    res.json({ ok:true, data:row });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const row = await db.oneOrNone(`
      UPDATE smart_city_attachments SET status='DECOMMISSIONED'
      WHERE attachment_id=$1 RETURNING attachment_id, sensor_type
    `, [req.params.id]);
    if (!row) return res.status(404).json({ ok:false, error:'Attachment not found' });
    res.json({ ok:true, message:'Sensor decommissioned', data:row });
  } catch(err) { res.status(500).json({ ok:false, error:'Internal server error' }); }
});

module.exports = router;