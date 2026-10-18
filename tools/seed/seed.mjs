#!/usr/bin/env node
import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL || 'http://gateway:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required.');
  process.exit(1);
}

const CATEGORIES = ['pothole', 'garbage', 'streetlight', 'water-leak'];
const CATEGORY_TITLES = {
  pothole: 'Damaged Road Pothole',
  garbage: 'Accumulated Garbage Waste',
  streetlight: 'Malfunctioning Streetlight',
  'water-leak': 'Underground Pipeline Leak'
};

const DEPARTMENTS = [
  { code: 'roads', email: 'officer.roads@civic.example.test', name: 'Roads Officer' },
  {
    code: 'sanitation',
    email: 'officer.sanitation@civic.example.test',
    name: 'Sanitation Officer'
  },
  {
    code: 'electricity',
    email: 'officer.electricity@civic.example.test',
    name: 'Electricity Officer'
  },
  { code: 'water', email: 'officer.water@civic.example.test', name: 'Water Officer' }
];

const DEMO_CITIZEN_PASSWORD = 'DemoCitizen#2026';
const CITIZENS = [
  { email: 'citizen1@civic.example.test', displayName: 'Demo Citizen 1' },
  { email: 'citizen2@civic.example.test', displayName: 'Demo Citizen 2' },
  { email: 'citizen3@civic.example.test', displayName: 'Demo Citizen 3' }
];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateRandomPassword() {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let pass = '';
  for (let i = 0; i < 16; i++) {
    pass += letters[crypto.randomInt(0, letters.length)];
  }
  return `${pass}#A1!`;
}

async function main() {
  // 1. Wait for gateway health
  const startHealth = Date.now();
  while (Date.now() - startHealth < 30000) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.status === 200) {
        const data = await res.json();
        if (data.status === 'ok') break;
      }
    } catch {}
    await sleep(1000);
  }

  // 2. Admin login
  const loginRes = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
  });

  if (loginRes.status !== 200) {
    const txt = await loginRes.text();
    console.error(`Admin login failed with status ${loginRes.status}: ${txt}`);
    process.exit(1);
  }

  const { accessToken: adminToken } = await loginRes.json();

  // 2. Fetch existing users to ensure idempotency
  let existingUserEmails = new Set();
  try {
    const usersRes = await fetch(`${BASE_URL}/api/v1/auth/users?pageSize=100`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (usersRes.status === 200) {
      const data = await usersRes.json();
      existingUserEmails = new Set((data.items || []).map((u) => u.email.toLowerCase()));
    }
  } catch {
    // If listing users fails, proceed optimistically with 409 handling
  }

  // 3. Ensure one officer per department
  let officersCreated = 0;
  let officersExisting = 0;

  for (const dept of DEPARTMENTS) {
    if (existingUserEmails.has(dept.email.toLowerCase())) {
      officersExisting++;
      continue;
    }

    const randomPass = generateRandomPassword();
    const createRes = await fetch(`${BASE_URL}/api/v1/auth/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        email: dept.email,
        password: randomPass,
        displayName: dept.name,
        role: 'officer'
      })
    });

    if (createRes.status === 201) {
      officersCreated++;
      // Printed ONCE to terminal, never stored
      console.log(`Created officer ${dept.email} with password: ${randomPass}`);
    } else if (createRes.status === 409) {
      officersExisting++;
    } else {
      const txt = await createRes.text();
      console.error(`Failed to create officer ${dept.email}: ${txt}`);
    }
  }

  // 4. Ensure 3 demo citizens
  let citizensCreated = 0;
  let citizensExisting = 0;

  for (const cit of CITIZENS) {
    if (existingUserEmails.has(cit.email.toLowerCase())) {
      citizensExisting++;
      continue;
    }

    const createRes = await fetch(`${BASE_URL}/api/v1/auth/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        email: cit.email,
        password: DEMO_CITIZEN_PASSWORD,
        displayName: cit.displayName,
        role: 'citizen'
      })
    });

    if (createRes.status === 201) {
      citizensCreated++;
    } else if (createRes.status === 409) {
      citizensExisting++;
    } else {
      const txt = await createRes.text();
      console.error(`Failed to create citizen ${cit.email}: ${txt}`);
    }
  }

  // 5. Login as citizen1 to create reports
  const citLoginRes = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: CITIZENS[0].email,
      password: DEMO_CITIZEN_PASSWORD
    })
  });

  if (citLoginRes.status !== 200) {
    const txt = await citLoginRes.text();
    console.error(`Citizen login failed with status ${citLoginRes.status}: ${txt}`);
    process.exit(1);
  }

  const { accessToken: citizenToken } = await citLoginRes.json();

  // 6. Create ~24 reports spread across the 5x5 ward grid and 4 categories
  let reportsCreated = 0;
  let reportsExisting = 0;
  const reports = [];

  const existingReportsByTitle = new Map();
  try {
    const mineRes = await fetch(`${BASE_URL}/api/v1/reports/mine?pageSize=100`, {
      headers: { Authorization: `Bearer ${citizenToken}` }
    });
    if (mineRes.status === 200) {
      const mineData = await mineRes.json();
      for (const item of mineData.items || []) {
        existingReportsByTitle.set(item.title, item);
      }
    }
  } catch {
    // If fetching mine fails, continue with POST fallback
  }

  for (let i = 0; i < 24; i++) {
    const r = (i % 5) + 1;
    const c = Math.floor(i / 5) + 1;
    const lat = +(22.95 + (r - 0.5) * 0.04).toFixed(4);
    const lng = +(72.45 + (c - 0.5) * 0.05).toFixed(4);
    const category = CATEGORIES[i % 4];
    const title = `${CATEGORY_TITLES[category]} at Ward R${r}C${c}`;
    const description = `Civic report #${i + 1} for ${category} in Ward R${r}C${c}`;
    const idempotencyKey = `seed-report-${i + 1}`;

    if (existingReportsByTitle.has(title)) {
      reportsExisting++;
      const existing = existingReportsByTitle.get(title);
      reports.push({ id: existing.id, index: i, wasCreated: false });
      continue;
    }

    const res = await fetch(`${BASE_URL}/api/v1/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${citizenToken}`,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        title,
        description,
        category,
        location: { lat, lng, address: `Ward R${r}C${c} Municipal Street` }
      })
    });

    if (res.status === 201) {
      const isReplay = res.headers.get('x-idempotent-replay') === 'true';
      if (isReplay) {
        reportsExisting++;
      } else {
        reportsCreated++;
      }
      const data = await res.json();
      reports.push({ id: data.id, index: i, wasCreated: !isReplay });
    } else if (res.status === 200) {
      reportsExisting++;
      const data = await res.json();
      reports.push({ id: data.id, index: i, wasCreated: false });
    } else {
      const txt = await res.text();
      console.warn(`Report creation #${i + 1} returned status ${res.status}: ${txt}`);
    }
  }

  // 7. Short wait to allow auto-assignment routing
  await sleep(2000);

  // 8. Progress ~12 reports through Verified -> In Progress -> Resolved, and ~3 Rejected
  let resolvedCount = 0;
  let rejectedCount = 0;
  let openCount = 0;

  for (const rep of reports) {
    try {
      const getRes = await fetch(`${BASE_URL}/api/v1/reports/${rep.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      if (getRes.status !== 200) continue;
      const current = await getRes.json();
      const st = current.status;

      if (st === 'Resolved') {
        resolvedCount++;
        continue;
      }
      if (st === 'Rejected') {
        rejectedCount++;
        continue;
      }

      if (rep.index < 12) {
        // Move through Verified, In Progress, Resolved
        if (st === 'Submitted') {
          await fetch(`${BASE_URL}/api/v1/reports/${rep.id}/status`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${adminToken}`
            },
            body: JSON.stringify({ toStatus: 'Verified' })
          });
        }

        // Check if now Assigned or Verify
        const cur2 = await (
          await fetch(`${BASE_URL}/api/v1/reports/${rep.id}`, {
            headers: { Authorization: `Bearer ${adminToken}` }
          })
        ).json();

        if (cur2.status === 'Verified') {
          await fetch(`${BASE_URL}/api/v1/reports/${rep.id}/status`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${adminToken}`
            },
            body: JSON.stringify({ toStatus: 'Assigned' })
          });
        }

        await fetch(`${BASE_URL}/api/v1/reports/${rep.id}/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`
          },
          body: JSON.stringify({ toStatus: 'In Progress' })
        });

        await fetch(`${BASE_URL}/api/v1/reports/${rep.id}/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`
          },
          body: JSON.stringify({
            toStatus: 'Resolved',
            note: 'Resolved by assigned department officer'
          })
        });

        resolvedCount++;
      } else if (rep.index >= 12 && rep.index < 15) {
        // Move to Rejected
        await fetch(`${BASE_URL}/api/v1/reports/${rep.id}/status`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`
          },
          body: JSON.stringify({
            toStatus: 'Rejected',
            reasonCode: 'duplicate',
            note: 'Duplicate of existing issue'
          })
        });
        rejectedCount++;
      } else {
        openCount++;
      }
    } catch {
      // Best-effort status transition
    }
  }

  // 9. Short summary of counts only
  console.log('Seed Summary:');
  console.log(`Officers: 4 (${officersCreated} created, ${officersExisting} existing)`);
  console.log(`Citizens: 3 (${citizensCreated} created, ${citizensExisting} existing)`);
  console.log(`Reports: 24 (${reportsCreated} created, ${reportsExisting} existing)`);
  console.log(`Resolved: ${resolvedCount}`);
  console.log(`Rejected: ${rejectedCount}`);
  console.log(`Open: ${openCount}`);
}

main().catch((err) => {
  console.error('Fatal error during seed execution:', err);
  process.exit(1);
});
