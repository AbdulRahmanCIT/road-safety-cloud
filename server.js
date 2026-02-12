const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');

const app = express();
const port = process.env.PORT || 5000;

/* ---------------- MIDDLEWARE ---------------- */

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- ROOT ROUTE ---------------- */

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ---------------- DATABASE ---------------- */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* Test DB connection */
pool.connect()
  .then(() => console.log('✅ PostgreSQL Connected'))
  .catch(err => console.error('❌ DB Connection Error:', err.message));

/* ---------------- POST API ---------------- */

app.post('/api/road-event', async (req, res) => {
  try {
    const {
      event_type,
      latitude,
      longitude,
      speed_kmph,
      accel_z,
      gyro_y
    } = req.body;

    /* ---------- Severity Calculation ---------- */

    let severity = 'Low';
    if (Math.abs(accel_z) > 5) severity = 'High';
    else if (Math.abs(accel_z) > 3) severity = 'Moderate';

    const isGpsValid =
      latitude !== null &&
      longitude !== null &&
      latitude !== undefined &&
      longitude !== undefined;

    /* ---------- Duplicate GPS Detection ---------- */

    if (isGpsValid) {
      const range = 0.001;

      const checkQuery = `
        SELECT id FROM road_events
        WHERE event_type = $1
        AND latitude BETWEEN ($2::numeric - $4::numeric)
                          AND ($2::numeric + $4::numeric)
        AND longitude BETWEEN ($3::numeric - $4::numeric)
                           AND ($3::numeric + $4::numeric)
        LIMIT 1`;

      const existing = await pool.query(checkQuery, [
        event_type,
        latitude,
        longitude,
        range,
      ]);

      if (existing.rows.length > 0) {
        const updateQuery = `
          UPDATE road_events
          SET vehicle_count = vehicle_count + 1,
              speed_kmph = $1,
              accel_z = $2,
              created_at = CURRENT_TIMESTAMP
          WHERE id = $3`;

        await pool.query(updateQuery, [
          speed_kmph,
          accel_z,
          existing.rows[0].id,
        ]);

        return res
          .status(200)
          .json({ message: 'Updated existing record' });
      }
    }

    /* ---------- Reverse Geocoding ---------- */

    let addressName = 'No GPS Fix';

    if (isGpsValid) {
      try {
        const mapRes = await axios.get(
          `https://nominatim.openstreetmap.org/reverse`,
          {
            params: {
              format: 'json',
              lat: latitude,
              lon: longitude,
            },
            headers: {
              'User-Agent': 'RoadHazardMonitor/1.0',
            },
            timeout: 5000,
          }
        );

        addressName =
          mapRes.data.address?.road ||
          mapRes.data.address?.suburb ||
          mapRes.data.display_name ||
          'Street Unknown';

      } catch (geoErr) {
        console.log('Geocode error:', geoErr.message);
        addressName = 'Location Lookup Error';
      }
    }

    /* ---------- Insert Query ---------- */

    const insertQuery = `
      INSERT INTO road_events
      (event_type, latitude, longitude, location,
       speed_kmph, accel_z, gyro_y,
       severity, status, vehicle_count)
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`;

    await pool.query(insertQuery, [
      event_type,
      latitude,
      longitude,
      addressName,
      speed_kmph,
      accel_z,
      gyro_y,
      severity,
      'Pending',
      1,
    ]);

    res.status(201).json({
      message: 'Created new record',
    });

  } catch (err) {
    console.error('POST Error:', err);
    res.status(500).send('Server Error');
  }
});

/* ---------------- GET API ---------------- */

app.get('/api/road-events', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM road_events ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET Error:', err);
    res.status(500).json({
      error: 'Failed to fetch road events',
    });
  }
});

/* ---------------- SERVER START ---------------- */

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});