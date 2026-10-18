#!/usr/bin/env node
import crypto from 'node:crypto';

const BASE_URL = process.env.BASE_URL || 'http://gateway:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAILPIT_URL = process.env.MAILPIT_URL;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required.');
  process.exit(1);
}

const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCABAAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3EKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//Z';

let failedCount = 0;

function pass(name) {
  console.log(`[PASS] ${name}`);
}

function fail(name, err) {
  failedCount++;
  console.error(`[FAIL] ${name}: ${err?.message || err || 'Unknown error'}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let adminToken = null;
  let officerToken = null;
  let officerEmail = null;
  let citizenToken = null;
  let citizenId = null;
  let citizenEmail = null;
  let reportId = null;
  let uploadedImageId = null;

  // 1. health through the gateway
  try {
    let healthy = false;
    let lastErr = null;
    const startHealth = Date.now();
    while (Date.now() - startHealth < 30000) {
      try {
        const res = await fetch(`${BASE_URL}/healthz`);
        if (res.status === 200) {
          const data = await res.json();
          if (data.status === 'ok') {
            healthy = true;
            break;
          }
        }
      } catch (err) {
        lastErr = err;
      }
      await sleep(1000);
    }
    if (!healthy) throw lastErr || new Error('Gateway healthcheck timed out after 30s');
    pass('health through the gateway');
  } catch (err) {
    fail('health through the gateway', err);
    process.exit(1);
  }

  // 2. admin login
  try {
    const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    });
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    if (!data.accessToken) throw new Error('Missing accessToken in login response');
    adminToken = data.accessToken;
    pass('admin login');
  } catch (err) {
    fail('admin login', err);
    process.exit(1);
  }

  // 3. admin creates an officer and a citizen (unique emails)
  const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  officerEmail = `e2e_officer_${uniqueSuffix}@civic.example.test`;
  citizenEmail = `e2e_citizen_${uniqueSuffix}@civic.example.test`;
  const officerPass = `OfficerPass#${uniqueSuffix}!`;
  const citizenPass = `CitizenPass#${uniqueSuffix}!`;

  try {
    const resOfficer = await fetch(`${BASE_URL}/api/v1/auth/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        email: officerEmail,
        password: officerPass,
        displayName: 'E2E Roads Officer',
        role: 'officer'
      })
    });
    if (resOfficer.status !== 201) {
      const errBody = await resOfficer.text();
      throw new Error(`Officer creation failed with status ${resOfficer.status}: ${errBody}`);
    }

    const resCitizen = await fetch(`${BASE_URL}/api/v1/auth/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        email: citizenEmail,
        password: citizenPass,
        displayName: 'E2E Citizen User',
        role: 'citizen'
      })
    });
    if (resCitizen.status !== 201) {
      const errBody = await resCitizen.text();
      throw new Error(`Citizen creation failed with status ${resCitizen.status}: ${errBody}`);
    }
    const citizenData = await resCitizen.json();
    citizenId = citizenData.id;

    pass('admin creates an officer and a citizen (unique emails)');
  } catch (err) {
    fail('admin creates an officer and a citizen (unique emails)', err);
    process.exit(1);
  }

  // 4. citizen login
  try {
    const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: citizenEmail, password: citizenPass })
    });
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    if (!data.accessToken) throw new Error('Missing accessToken');
    citizenToken = data.accessToken;

    const resOff = await fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: officerEmail, password: officerPass })
    });
    if (resOff.status !== 200) throw new Error(`Officer login status ${resOff.status}`);
    const offData = await resOff.json();
    officerToken = offData.accessToken;

    pass('citizen login');
  } catch (err) {
    fail('citizen login', err);
    process.exit(1);
  }

  // 5. public categories
  try {
    const res = await fetch(`${BASE_URL}/api/v1/public/categories`);
    if (res.status !== 200) throw new Error(`Status ${res.status}`);
    const categories = await res.json();
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new Error('Categories list empty or not array');
    }
    pass('public categories');
  } catch (err) {
    fail('public categories', err);
    process.exit(1);
  }

  // 6. citizen creates a report inside the grid (lat 23.03 lng 72.58) with an Idempotency-Key (repeat = same id)
  const idempotencyKey = crypto.randomUUID();
  try {
    const payload = {
      title: 'E2E Damaged Road Crater',
      description: 'Severe road surface damage requiring immediate repair',
      category: 'pothole',
      location: {
        lat: 23.03,
        lng: 72.58,
        address: 'MG Road Junction Ward 3'
      }
    };

    const res1 = await fetch(`${BASE_URL}/api/v1/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${citizenToken}`,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(payload)
    });

    if (res1.status !== 201) {
      const txt = await res1.text();
      throw new Error(`First report creation returned status ${res1.status}: ${txt}`);
    }
    const data1 = await res1.json();
    reportId = data1.id;
    if (!reportId) throw new Error('Missing report id');

    // Repeated request with same Idempotency-Key
    const res2 = await fetch(`${BASE_URL}/api/v1/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${citizenToken}`,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(payload)
    });

    const data2 = await res2.json();
    if (data2.id !== reportId) {
      throw new Error(`Expected identical reportId on idempotent retry: ${reportId} vs ${data2.id}`);
    }

    pass(
      'citizen creates a report inside the grid (lat 23.03 lng 72.58) with an Idempotency-Key (repeat = same id)'
    );
  } catch (err) {
    fail(
      'citizen creates a report inside the grid (lat 23.03 lng 72.58) with an Idempotency-Key (repeat = same id)',
      err
    );
    process.exit(1);
  }

  // 7. within 20 s the report is Assigned automatically (history contains changed_by 'system')
  try {
    let isAssigned = false;
    let hasSystemHistory = false;
    const startTime = Date.now();

    while (Date.now() - startTime < 20000) {
      const res = await fetch(`${BASE_URL}/api/v1/reports/${reportId}`, {
        headers: { Authorization: `Bearer ${citizenToken}` }
      });

      if (res.status === 200) {
        const rep = await res.json();
        if (rep.status === 'Assigned') {
          isAssigned = true;
          if (Array.isArray(rep.history)) {
            hasSystemHistory = rep.history.some(
              (h) => h.changedBy === 'system' && h.toStatus === 'Assigned'
            );
          }
          if (hasSystemHistory) break;
        }
      }
      await sleep(500);
    }

    if (!isAssigned) {
      throw new Error('Report was not Assigned within 20s');
    }
    if (!hasSystemHistory) {
      throw new Error("Report history does not contain changed_by 'system' entry");
    }

    pass(
      "within 20 s the report is Assigned automatically (history contains changed_by 'system')"
    );
  } catch (err) {
    fail(
      "within 20 s the report is Assigned automatically (history contains changed_by 'system')",
      err
    );
    process.exit(1);
  }

  // 8. public list and bbox contain it and a far bbox does not
  try {
    // Check public list contains reportId
    const resList = await fetch(`${BASE_URL}/api/v1/public/reports?status=open&pageSize=50`);
    if (resList.status !== 200) throw new Error(`Public list status ${resList.status}`);
    const listData = await resList.json();
    const inList = listData.items.some((r) => r.id === reportId);
    if (!inList) throw new Error(`Report ${reportId} not found in public reports list`);

    // Intersecting bbox: 72.50,23.00,72.60,23.10 contains (23.03, 72.58)
    const resBboxMatch = await fetch(
      `${BASE_URL}/api/v1/public/reports?bbox=72.50,23.00,72.60,23.10`
    );
    if (resBboxMatch.status !== 200) throw new Error(`Bbox match status ${resBboxMatch.status}`);
    const bboxData = await resBboxMatch.json();
    const inBbox = bboxData.items.some((r) => r.id === reportId);
    if (!inBbox) throw new Error('Report not found in matching bounding box');

    // Far bbox: 10.00,10.00,11.00,11.00 does not contain report
    const resBboxFar = await fetch(`${BASE_URL}/api/v1/public/reports?bbox=10.00,10.00,11.00,11.00`);
    if (resBboxFar.status !== 200) throw new Error(`Far bbox status ${resBboxFar.status}`);
    const farData = await resBboxFar.json();
    const inFar = farData.items.some((r) => r.id === reportId);
    if (inFar) throw new Error('Report unexpectedly found in far bounding box');

    pass('public list and bbox contain it and a far bbox does not');
  } catch (err) {
    fail('public list and bbox contain it and a far bbox does not', err);
    process.exit(1);
  }

  // 9. officer moves it In Progress then Resolved
  try {
    const resProgress = await fetch(`${BASE_URL}/api/v1/reports/${reportId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${officerToken}`
      },
      body: JSON.stringify({ toStatus: 'In Progress' })
    });
    if (resProgress.status !== 200) {
      const txt = await resProgress.text();
      throw new Error(`In Progress transition failed (${resProgress.status}): ${txt}`);
    }

    const resResolved = await fetch(`${BASE_URL}/api/v1/reports/${reportId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${officerToken}`
      },
      body: JSON.stringify({
        toStatus: 'Resolved',
        note: 'Issue successfully resolved by municipal officer'
      })
    });
    if (resResolved.status !== 200) {
      const txt = await resResolved.text();
      throw new Error(`Resolved transition failed (${resResolved.status}): ${txt}`);
    }

    pass('officer moves it In Progress then Resolved');
  } catch (err) {
    fail('officer moves it In Progress then Resolved', err);
    process.exit(1);
  }

  // 10. citizen reopens it
  try {
    const resReopen = await fetch(`${BASE_URL}/api/v1/reports/${reportId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${citizenToken}`
      },
      body: JSON.stringify({
        toStatus: 'Reopened',
        note: 'Pothole opened up again after rains'
      })
    });
    if (resReopen.status !== 200) {
      const txt = await resReopen.text();
      throw new Error(`Reopen transition failed (${resReopen.status}): ${txt}`);
    }

    pass('citizen reopens it');
  } catch (err) {
    fail('citizen reopens it', err);
    process.exit(1);
  }

  // 11. admin summary reflects it
  try {
    const resSummary = await fetch(`${BASE_URL}/api/v1/analytics/summary`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (resSummary.status !== 200) {
      throw new Error(`Summary endpoint returned status ${resSummary.status}`);
    }
    const summaryData = await resSummary.json();
    if (typeof summaryData.totalReports !== 'number' || summaryData.totalReports < 1) {
      throw new Error(`Summary does not reflect reports: ${JSON.stringify(summaryData)}`);
    }

    pass('admin summary reflects it');
  } catch (err) {
    fail('admin summary reflects it', err);
    process.exit(1);
  }

  // 12. audit log (admin) contains user.created, report.submitted, report.assigned and report.status-changed for it
  try {
    let foundCreated = false;
    let foundSubmitted = false;
    let foundAssigned = false;
    let foundStatusChanged = false;

    const startPoll = Date.now();
    while (Date.now() - startPoll < 15000) {
      const resAudit = await fetch(`${BASE_URL}/api/v1/analytics/audit?limit=100`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      if (resAudit.status === 200) {
        const auditData = await resAudit.json();
        const items = auditData.items || [];

        foundCreated = items.some((i) => i.eventType === 'user.created');
        foundSubmitted = items.some(
          (i) => i.eventType === 'report.submitted' && i.subjectId === reportId
        );
        foundAssigned = items.some(
          (i) => i.eventType === 'report.assigned' && i.subjectId === reportId
        );
        foundStatusChanged = items.some(
          (i) => i.eventType === 'report.status-changed' && i.subjectId === reportId
        );

        if (foundCreated && foundSubmitted && foundAssigned && foundStatusChanged) {
          break;
        }
      }
      await sleep(500);
    }

    if (!foundCreated || !foundSubmitted || !foundAssigned || !foundStatusChanged) {
      throw new Error(
        `Audit log missing events for report: created=${foundCreated}, submitted=${foundSubmitted}, assigned=${foundAssigned}, statusChanged=${foundStatusChanged}`
      );
    }

    pass(
      'audit log (admin) contains user.created, report.submitted, report.assigned and report.status-changed for it'
    );
  } catch (err) {
    fail(
      'audit log (admin) contains user.created, report.submitted, report.assigned and report.status-changed for it',
      err
    );
    process.exit(1);
  }

  // 13. a citizen calling an admin route gets 403 and no token 401
  try {
    const resNoToken = await fetch(`${BASE_URL}/api/v1/auth/users`);
    if (resNoToken.status !== 401) {
      throw new Error(`Expected 401 on missing token, got ${resNoToken.status}`);
    }

    const resCitizenAdmin = await fetch(`${BASE_URL}/api/v1/auth/users`, {
      headers: { Authorization: `Bearer ${citizenToken}` }
    });
    if (resCitizenAdmin.status !== 403) {
      throw new Error(`Expected 403 on citizen calling admin route, got ${resCitizenAdmin.status}`);
    }

    pass('a citizen calling an admin route gets 403 and no token 401');
  } catch (err) {
    fail('a citizen calling an admin route gets 403 and no token 401', err);
    process.exit(1);
  }

  // 14. an upload of a tiny JPEG (generate a valid 64x64 JPEG from an embedded base64 constant) reaches status ready and the public thumbnail answers 200 image/jpeg
  try {
    const rawJpeg = Buffer.from(TINY_JPEG_B64, 'base64');
    const formData = new FormData();
    const fileBlob = new Blob([rawJpeg], { type: 'image/jpeg' });
    formData.append('file', fileBlob, 'photo.jpg');

    let resUpload = await fetch(`${BASE_URL}/api/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenToken}` },
      body: formData
    });

    if (resUpload.status === 504) {
      // Retry once in case of cold-start upstream timeout
      await sleep(1000);
      const retryForm = new FormData();
      retryForm.append('file', fileBlob, 'photo.jpg');
      resUpload = await fetch(`${BASE_URL}/api/v1/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${citizenToken}` },
        body: retryForm
      });
    }

    if (resUpload.status !== 202) {
      const txt = await resUpload.text();
      throw new Error(`Upload returned status ${resUpload.status}: ${txt}`);
    }

    const uploadData = await resUpload.json();
    uploadedImageId = uploadData.imageId;

    // Poll until image status is 'ready'
    let isReady = false;
    const startPollImage = Date.now();
    while (Date.now() - startPollImage < 20000) {
      const resImg = await fetch(`${BASE_URL}/api/v1/images/${uploadedImageId}`, {
        headers: { Authorization: `Bearer ${citizenToken}` }
      });
      if (resImg.status === 200) {
        const meta = await resImg.json();
        if (meta.status === 'ready') {
          isReady = true;
          break;
        }
      }
      await sleep(500);
    }

    if (!isReady) {
      throw new Error('Image did not reach status ready within 20s');
    }

    // Public thumbnail test
    const resThumb = await fetch(`${BASE_URL}/api/v1/images/${uploadedImageId}/thumbnail`);
    if (resThumb.status !== 200) {
      throw new Error(`Thumbnail returned status ${resThumb.status}`);
    }
    const contentType = resThumb.headers.get('content-type') || '';
    if (!contentType.includes('image/jpeg')) {
      throw new Error(`Expected image/jpeg content-type, got ${contentType}`);
    }

    pass(
      'an upload of a tiny JPEG (generate a valid 64x64 JPEG from an embedded base64 constant) reaches status ready and the public thumbnail answers 200 image/jpeg'
    );
  } catch (err) {
    fail(
      'an upload of a tiny JPEG (generate a valid 64x64 JPEG from an embedded base64 constant) reaches status ready and the public thumbnail answers 200 image/jpeg',
      err
    );
    process.exit(1);
  }

  // 15. when MAILPIT_URL is set, Mailpit shows the welcome, received, assigned and department emails for the citizen
  if (MAILPIT_URL) {
    try {
      let foundWelcome = false;
      let foundReceived = false;
      let foundAssigned = false;
      let foundDepartment = false;

      const startPollMail = Date.now();
      while (Date.now() - startPollMail < 20000) {
        try {
          const resMail = await fetch(`${MAILPIT_URL}/api/v1/messages`);
          if (resMail.status === 200) {
            const mailData = await resMail.json();
            const msgs = mailData.messages || [];

            for (const m of msgs) {
              const subject = m.Subject || '';
              const toList = (m.To || []).map((t) => t.Address.toLowerCase());

              if (toList.includes(citizenEmail.toLowerCase())) {
                if (subject.includes('Welcome')) foundWelcome = true;
                if (subject.includes('We received your report')) foundReceived = true;
                if (subject.includes('Assigned')) foundAssigned = true;
              }

              if (subject.includes('New report assigned to')) {
                foundDepartment = true;
              }
            }

            if (foundWelcome && foundReceived && foundAssigned && foundDepartment) {
              break;
            }
          }
        } catch {
          // Retry until timeout
        }
        await sleep(500);
      }

      if (!foundWelcome || !foundReceived || !foundAssigned || !foundDepartment) {
        throw new Error(
          `Mailpit missing emails: welcome=${foundWelcome}, received=${foundReceived}, assigned=${foundAssigned}, department=${foundDepartment}`
        );
      }

      pass(
        'when MAILPIT_URL is set, Mailpit shows the welcome, received, assigned and department emails for the citizen'
      );
    } catch (err) {
      fail(
        'when MAILPIT_URL is set, Mailpit shows the welcome, received, assigned and department emails for the citizen',
        err
      );
      process.exit(1);
    }
  } else {
    pass(
      'when MAILPIT_URL is set, Mailpit shows the welcome, received, assigned and department emails for the citizen (skipped: MAILPIT_URL not configured)'
    );
  }

  if (failedCount > 0) {
    console.error(`E2E completed with ${failedCount} failures.`);
    process.exit(1);
  } else {
    console.log('All E2E checks passed successfully.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal unhandled error in E2E runner:', err);
  process.exit(1);
});
