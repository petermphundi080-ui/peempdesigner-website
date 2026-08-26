# Security checklist

## Secrets

- Keep `.env` local and out of source control.
- Revoke and replace any Gmail App Password that has been shared or committed.
- Set `EMAIL_USER`, `EMAIL_PASS`, and `EMAIL_TO` only through the deployment secret manager.

## Deployment

- Put the Node server behind an HTTPS reverse proxy such as Caddy or Nginx. Redirect HTTP to HTTPS and set `TRUST_PROXY=true` only after configuring the proxy correctly.
- Keep Node.js and dependencies current. Run `npm audit` and review updates before deployment.
- The current rate limiter is in-memory and per process. Use a shared store such as Redis when running multiple instances.
- No admin area or upload endpoint exists yet. If either is added, require strong password-hashed authentication with MFA for admins, and enforce an allowlist of file types, size limits, generated filenames, and storage outside the public directory.

## Contact endpoint

The server validates method, origin, content type, body size, required fields, field lengths, project values, email format, and a honeypot field. It also applies a per-IP request limit.