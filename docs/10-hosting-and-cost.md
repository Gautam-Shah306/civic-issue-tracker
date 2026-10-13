# 10: Hosting and Cost

> **Status:** Approved · **Last updated:** 2026-10-13
> Cloud/local hosting is worth **2 marks** and the public link **2 marks**.
> **Cost rule:** everything stays within free-tier resources. Paid resources are a **last resort**.
> **Volatile facts below were verified on 2026-10-09. Re-check them before cloud sign-up (see the checklist in section 7).**

---

## 1. Requirements that shape hosting

- The public link needs to stay live for about **one month** after the project is complete, with **at most roughly 100 requests** in that time.
- All development and testing happens locally first. The cloud account is created **last** (Phase 5), so the credit clock starts as late as possible.
- Workload: 8 services plus Postgres, RabbitMQ, Redis, SeaweedFS and monitoring, planned for a single **VM of about 2 vCPU and 8 GB RAM** running k3s.

## 2. Options researched (verified 2026-10-09)

| | AWS Free Plan | GCP Free Trial | Oracle Always Free |
|---|---|---|---|
| **Free resource** | Up to $200 in credits | $300 in credits | About 2 OCPU / 12 GB, permanent |
| **Duration** | Up to 6 months, or until credits run out | 90 days | No expiry |
| **Overspend risk** | None on the Free Plan | None unless you upgrade | Instances are deleted if limits are exceeded |
| **Main catch** | Account closes at the end | Hard 90-day stop | VM creation often fails with capacity errors |

### AWS details
- New accounts (created after 15 July 2025) get a credit-based plan instead of 12 months of free EC2: $100 immediately plus up to $100 more for onboarding tasks, maximum $200.
- The plan ends after 6 months or when credits run out, whichever comes first, and the account then closes automatically. AWS gives a 90-day grace period for data.
- On the Free Plan you are not billed even if usage exceeds the credits.
- Some services are blocked on the Free Plan. Allowed instance types were not confirmed; check at sign-up.
- The old free micro instance (1 GB RAM) is far too small for this project.

### GCP details
- New customers get $300 in credit that expires after 90 days regardless of balance. A card is required but is not charged automatically.
- The permanently free e2-micro VM works only in three US regions and is tiny, so it cannot host the project.
- Managed Kubernetes (GKE) is not used. k3s on one VM is cheaper and fits better (approved in `06`).

### Oracle details (backup only)
- Sources disagree on the current Always Free size. One breakdown says the Ampere A1 limit drops to 2 OCPUs and 12 GB in total from June 2026, down from 4 OCPUs and 24 GB. Oracle's own page still showed the older figure. **Plan for 2 OCPU / 12 GB.**
- Sign-up usually needs a phone number and a credit card. The home region is fixed at sign-up. Always Free ARM VMs often fail to create with "out of capacity" errors. Exceeding the free limits means instances are disabled and later deleted.

## 3. Decision

1. **Primary host: GCP Free Trial** (one VM, k3s). $300 over 90 days comfortably covers one 8 GB VM at about 100 requests.
2. **AWS Free Plan is the alternative.** The provider-agnostic Terraform design (`07`) makes it a one-module swap. Choose AWS instead if the live period needs to extend beyond GCP's 90 days.
3. **Oracle Always Free is an emergency backup only**, used only if required.
4. **Last-resort fallback:** the developer's own machine running k3s or kind behind a free tunnel (the URL changes on restart and it only works while the machine is on).
5. **The cloud account is created last (Phase 5)** so the 90-day clock covers deployment, final checks and the live month.
- Cloud account timing changed by D-039: created at the end of v1 (cycle 8).

## 4. Budget estimates (estimates only, check the pricing calculators)

- An 8 GB VM costs roughly **$50 to $60 per month** on either provider. A 4 GB VM (about $30 per month) is too tight for this stack.
- $200 buys about 3 months of continuous running on AWS. GCP's $300 comfortably covers its 90-day window.

## 5. Credit guardrails

- Set a **billing budget alert**.
- **Never upgrade** to a paid account. On AWS, stay on the Free Plan.
- **Stop the VM** (variable `vm_enabled`) between test and demo windows. Credits are spent only while it runs.
- Watch the small hidden costs: **public IP addresses**, **outbound data transfer** and **disk size**.
- **Teardown:** `terraform destroy` after the live month ends.

## 6. Public URL and TLS

- **Domain:** a free dynamic-DNS subdomain (for example DuckDNS) pointing at the VM's static IP. A custom domain costs money, so it is a last resort.
- **TLS:** Let's Encrypt certificates issued automatically by cert-manager on the Traefik ingress. Use the staging issuer first to avoid rate limits.
- **Open ports:** 80 and 443 only. SSH only through the IAP tunnel (`07`).

## 7. Re-check checklist (do this immediately before Phase 5 sign-up)

- [ ] Current credit amount and duration for GCP (and AWS if used)
- [ ] Whether a card is required and whether it can be charged automatically
- [ ] Which machine types are allowed on the plan
- [ ] Pricing for the chosen region (Mumbai is the likely region) for VM, static IP, disk and egress
- [ ] Whether budget alerts can be created for this account
- [ ] Any trial restrictions that affect running a VM with a public IP
- [ ] That the signing-up account counts as a **new customer**
- [ ] Current state of the Oracle Always Free offer (only if the fallback is needed)

## 8. Risks specific to hosting

| Risk | Mitigation |
|---|---|
| Free-tier terms change | Keep everything portable (containers, Terraform variables); re-check before sign-up |
| Credits run out early | Create the account late, stop the VM between sessions, budget alerts |
| Sign-up or verification problems | Local fallback and Oracle backup |
| VM runs out of memory | Measure on local k3s in Phase 3 with real limits |
| Email limits on free providers | Mailpit in development; a free-tier email service for the live demo only (about 100 requests is trivial) |

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| Final region, machine type and disk size | Phase 5 |
| Free DNS provider (DuckDNS or similar) | Phase 5 |
| Free-tier email service for the live demo | Phase 5 |
| Whether the live period is extended (which would favour AWS) | Phase 5 |
| Date to run `terraform destroy` | Phase 5 |
