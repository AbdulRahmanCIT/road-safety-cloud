const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');



const app = express();
const port = process.env.PORT || 5000;


app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'))); 

console.log(
  "DATABASE_URL:",
  process.env.DATABASE_URL ? "Loaded ✅" : "Missing ❌"
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});


app.post('/api/road-event', async (req, res) => {
  try {
    const { event_type, latitude, longitude, speed_kmph, accel_z, gyro_y } = req.body;
    
    let severity = 'Low';
    if (Math.abs(accel_z) > 5.0) severity = 'High';
    else if (Math.abs(accel_z) > 3.0) severity = 'Moderate';

    const isGpsValid = (latitude != 0 && latitude != null && longitude != 0);

    // --- STEP 1: ATTEMPT TO FIND AND UPDATE EXISTING RECORD ---
    if (isGpsValid) {
        const range = 0.001; // Approx 100 meters to catch GPS drift

        const checkQuery = `
          SELECT id FROM road_events 
          WHERE event_type = $1 
          AND latitude BETWEEN ($2 - $4) AND ($2 + $4)
          AND longitude BETWEEN ($3 - $4) AND ($3 + $4)
          LIMIT 1`;
        
        const existing = await pool.query(checkQuery, [event_type, latitude, longitude, range]);

        if (existing.rows.length > 0) {
            const updateQuery = `
                UPDATE road_events 
                SET vehicle_count = COALESCE(vehicle_count, 1) + 1,
                    speed_kmph = $1,
                    accel_z = $2,
                    created_at = CURRENT_TIMESTAMP
                WHERE id = $3`;
            
            await pool.query(updateQuery, [speed_kmph, accel_z, existing.rows[0].id]);
            
            console.log(`✅ SUCCESS: Incremented vehicle count for ID ${existing.rows[0].id}`);
            return res.status(200).json({ message: "Updated existing record" });
            // ^ THE RETURN STATEMENT ABOVE IS CRITICAL. IT PREVENTS A NEW ROW FROM BEING ADDED.
        }
    }

    // --- STEP 2: IF NO MATCH WAS FOUND, CREATE A NEW ROW ---
    let addressName = isGpsValid ? "Fetching Address..." : "No GPS Fix";
    if (isGpsValid) {
        try {
            const mapRes = await axios.get(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`, { 
                headers: { 'User-Agent': 'RoadSafetyProject/1.0' } 
            });
            addressName = mapRes.data.address.road || mapRes.data.address.suburb || "Street Unknown";
        } catch (e) { addressName = "Location Lookup Error"; }
    }

    const insertQuery = `
      INSERT INTO road_events 
      (event_type, latitude, longitude, location, speed_kmph, accel_z, gyro_y, severity, status, vehicle_count) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending', 1)`;
    
    await pool.query(insertQuery, [event_type, latitude, longitude, addressName, speed_kmph, accel_z, gyro_y, severity]);
    
    console.log("🆕 NEW LOCATION: Created a new unique record.");
    res.status(201).json({ message: "Created new record" });

  } catch (err) { 
    console.error("❌ ERROR:", err.message);
    res.status(500).send("Server Error"); 
  }
});

// GET all road events
app.get('/api/road-events', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM road_events ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch Error:', err);
    res.status(500).json({ error: 'Failed to fetch road events' });
  }
});


app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Server Running at http://localhost:${port}`);
});