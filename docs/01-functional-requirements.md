# 01: Functional Requirements

> **Status:** Approved · **Last updated:** 2026-10-09
> **Scope rule:** implement all **[Core]** and **[Should]** items. **[Optional]** items stay open and are built later only if the need arises.

Each requirement has an ID. Use the ID in prompts, commits, tests and pull requests.

---

## 1. Users and roles

| ID | Requirement | Tier |
|---|---|---|
| ROLE-01 | **Citizen:** reports issues and tracks their own reports | Core |
| ROLE-02 | **Guest (public visitor):** views open issues without logging in | Core |
| ROLE-03 | **Department officer / ward staff:** handles issues assigned to their department or ward | Core |
| ROLE-04 | **Admin:** manages users, departments, wards, categories and settings | Core |
| ROLE-05 | **Super admin:** oversees all wards and departments | Optional |

## 2. Authentication and accounts

| ID | Requirement | Tier |
|---|---|---|
| AUTH-01 | Citizen registration and login with email or phone and password | Core |
| AUTH-02 | Role-based access control (citizen, officer, admin) | Core |
| AUTH-03 | Token-based sessions (JWT) with logout | Core |
| AUTH-04 | Password reset | Should |
| AUTH-05 | Email or OTP verification | Optional |
| AUTH-06 | Profile management (name, contact details, notification preferences) | Should |
| AUTH-07 | Admin creation of officer accounts | Core |

## 3. Report submission

| ID | Requirement | Tier |
|---|---|---|
| RPT-01 | Submit a report with title, description, category, photo and location | Core |
| RPT-02 | Location by map pin, browser GPS, or manual address | Core |
| RPT-03 | Photo upload with type and size validation | Core |
| RPT-04 | Multiple photos per report | Should |
| RPT-05 | Anonymous reporting | Optional |
| RPT-06 | Duplicate detection (same category near the same location) with a prompt to upvote the existing report instead | Should |
| RPT-07 | Severity or urgency selection by the citizen | Optional |
| RPT-08 | Draft saving or offline submission | Optional |

## 4. Image processing

| ID | Requirement | Tier |
|---|---|---|
| IMG-01 | Resize, compress and generate thumbnails | Core |
| IMG-02 | Strip EXIF metadata (privacy) after reading GPS data if present | Should |
| IMG-03 | Basic file validation and malware or format checks | Should |
| IMG-04 | Automatic category suggestion from the image (ML) | Optional |
| IMG-05 | Blurring of faces and number plates | Optional |

## 5. Assignment and routing

| ID | Requirement | Tier |
|---|---|---|
| RTE-01 | Map each report to a ward based on its location | Core |
| RTE-02 | Map each category to a department (pothole to Roads, garbage to Sanitation, streetlight to Electricity) | Core |
| RTE-03 | Automatic assignment to the correct department and ward | Core |
| RTE-04 | Manual reassignment by an admin | Core |
| RTE-05 | Assignment to a specific officer within a department | Should |
| RTE-06 | Priority scoring based on category, severity and upvotes | Should |
| RTE-07 | Escalation when a report breaches its SLA | Should |

## 6. Status lifecycle

| ID | Requirement | Tier |
|---|---|---|
| STS-01 | Statuses: **Submitted, Verified, Assigned, In Progress, Resolved, Closed**, plus **Rejected** and **Reopened** | Core |
| STS-02 | Defined valid transitions (for example only an officer can move a report to In Progress) | Core |
| STS-03 | Officer updates with notes | Core |
| STS-04 | Resolution proof: the officer uploads an "after" photo | Should |
| STS-05 | Citizen confirmation or rejection of the resolution, which can reopen the report | Should |
| STS-06 | Full status history and audit trail for every report | Core |
| STS-07 | Rejection with a reason (duplicate, invalid, out of jurisdiction) | Core |

## 7. Notifications

| ID | Requirement | Tier |
|---|---|---|
| NTF-01 | Notify the citizen on submission and on every status change | Core |
| NTF-02 | Notify the officer or department when a report is assigned | Core |
| NTF-03 | Email as the main channel | Core |
| NTF-04 | In-app notifications | Should |
| NTF-05 | SMS or push notifications | Optional |
| NTF-06 | Per-user notification preferences | Optional |

## 8. Citizen portal

| ID | Requirement | Tier |
|---|---|---|
| CIT-01 | "My Reports" list with a status filter | Core |
| CIT-02 | Report detail page with timeline, photos and location | Core |
| CIT-03 | Edit or cancel a report before it is assigned | Should |
| CIT-04 | Comment on a report or add more information | Should |
| CIT-05 | Feedback and rating after resolution | Optional |

## 9. Public view

| ID | Requirement | Tier |
|---|---|---|
| PUB-01 | Map of open issues with markers | Core |
| PUB-02 | List view with filters (category, ward, status, date) | Core |
| PUB-03 | Public report detail without personal data | Core |
| PUB-04 | Upvote or "me too" on existing issues | Should |
| PUB-05 | Public statistics (issues reported, resolved, average resolution time) | Should |
| PUB-06 | Search by area or keyword | Optional |

## 10. Officer and admin dashboard

| ID | Requirement | Tier |
|---|---|---|
| DSH-01 | Officer: queue of assigned issues, update status, add notes | Core |
| DSH-02 | Admin: view all reports with filters by status, ward, department and date | Core |
| DSH-03 | Analytics: counts by status, category and ward, resolution time, SLA breaches | Should |
| DSH-04 | Map heatmap of problem areas | Optional |
| DSH-05 | CSV or PDF export of reports | Optional |
| DSH-06 | Manage departments, wards, categories and SLA rules | Core |
| DSH-07 | User management (activate, deactivate, change roles) | Core |

## 11. Moderation and abuse control

| ID | Requirement | Tier |
|---|---|---|
| MOD-01 | Flag and remove spam or inappropriate reports | Should |
| MOD-02 | Rate limiting on submissions per user | Should |
| MOD-03 | CAPTCHA on signup or submission | Optional |

## 12. Cross-cutting

| ID | Requirement | Tier |
|---|---|---|
| XCT-01 | Audit log of admin and officer actions | Core |
| XCT-02 | Pagination, sorting and search on all lists | Core |
| XCT-03 | Input validation and clear error messages | Core |
| XCT-04 | Multi-language support (English, Gujarati, Hindi) | Optional |
| XCT-05 | API documentation (Swagger/OpenAPI) | Should |

---

## Scope notes

- **Data is synthetic.** Wards, departments, categories, users and reports are generated (see `11`). No real ward data is used.
- **If time runs short**, **[Should]** items are dropped in the order given in `11-scope-and-phases.md` section 5. Core items are never dropped.

## Deferred decisions

These were intentionally left open. Settle each in the phase shown and record it here and in `12-decision-log.md`.

| Decision | Settle in |
|---|---|
| Exact status transition table (who may move a report from which status to which) | Phase 1 |
| Report categories and the category-to-department mapping | Phase 2 |
| SLA values per category | Phase 4 |
| Priority scoring formula | Phase 4 |
| Duplicate detection radius and matching rules | Phase 4 |
| Upvote rules (one per user, anonymous upvotes or not) | Phase 4 |
| Notification content and templates | Phase 1 |
| Photo limits (file size, count, accepted types) | Phase 2 |
| Retention policy for closed reports | Optional, later |
