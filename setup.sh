#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# InRange ISA System — One-command setup
# Run: bash setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

info()    { echo -e "${BLUE}→${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}!${NC} $1"; }
fatal()   { echo -e "${RED}✗ $1${NC}"; exit 1; }
section() { echo ""; echo -e "${BOLD}── $1 ─$(printf '─%.0s' $(seq 1 $((48 - ${#1}))))${NC}"; }
ask()     { echo -e "${BOLD}$1${NC}"; }

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo -e "${BOLD}"
cat <<'BANNER'
  ╔════════════════════════════════════════════════╗
  ║   InRange ISA System                           ║
  ║   AI-powered sales engine for 1-person cos.    ║
  ║                                                ║
  ║   Setup takes ~5 minutes. Have ready:          ║
  ║     • Supabase project URL + keys              ║
  ║     • Anthropic API key                        ║
  ║     • Twilio Account SID + token + number      ║
  ╚════════════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
section "Checking prerequisites"

command -v node >/dev/null 2>&1 || fatal "Node.js not found. Install v18+ from nodejs.org"
command -v npm  >/dev/null 2>&1 || fatal "npm not found."
command -v git  >/dev/null 2>&1 || fatal "git not found."

NODE_VER=$(node -v | sed 's/v//' | cut -d'.' -f1)
[ "$NODE_VER" -ge 18 ] || fatal "Node.js v18+ required (found $(node -v)). Update at nodejs.org"
success "Node $(node -v)  npm $(npm -v)"

HAS_SUPABASE=false
if command -v supabase >/dev/null 2>&1; then
  HAS_SUPABASE=true
  success "Supabase CLI $(supabase --version 2>/dev/null | head -1)"
else
  warn "Supabase CLI not found — secrets and migrations will need manual setup"
  warn "Install later with: brew install supabase/tap/supabase"
fi

HAS_VERCEL=false
if command -v vercel >/dev/null 2>&1; then
  HAS_VERCEL=true
  success "Vercel CLI found"
fi

echo ""

# ── 2. Collect configuration ──────────────────────────────────────────────────
section "Business"
ask "Business name — used in SMS sign-offs (e.g. 'Highline NY')"
read -rp "  > " BUSINESS_NAME
BUSINESS_NAME="${BUSINESS_NAME:-InRange}"

ask "Markets to activate — comma-separated keys (e.g. nyc,nj or nyc or miami)"
read -rp "  > [nyc,nj] " MARKETS
MARKETS="${MARKETS:-nyc,nj}"

section "Supabase  →  supabase.com/dashboard → project → Settings → API"
ask "Project URL (https://xxxxx.supabase.co)"
read -rp "  > " SUPABASE_URL
[[ "$SUPABASE_URL" == https://*.supabase.co ]] || fatal "Must be https://xxxxx.supabase.co"

ask "Anon/Public Key"
read -rp "  > " SUPABASE_ANON_KEY
[[ -n "$SUPABASE_ANON_KEY" ]] || fatal "Anon key required"

ask "Service Role Key (secret — input hidden)"
read -rsp "  > " SUPABASE_SERVICE_ROLE_KEY; echo ""
[[ -n "$SUPABASE_SERVICE_ROLE_KEY" ]] || fatal "Service role key required"

SUPABASE_PROJECT_ID=$(echo "$SUPABASE_URL" | sed 's|https://||' | cut -d'.' -f1)

section "Anthropic  →  console.anthropic.com → API Keys"
ask "API Key (input hidden)"
read -rsp "  > " ANTHROPIC_API_KEY; echo ""
[[ -n "$ANTHROPIC_API_KEY" ]] || fatal "Anthropic API key required"

section "Twilio  →  console.twilio.com"
ask "Account SID (starts with AC...)"
read -rp "  > " TWILIO_ACCOUNT_SID
[[ "$TWILIO_ACCOUNT_SID" == AC* ]] || fatal "SID must start with AC"

ask "Auth Token (input hidden)"
read -rsp "  > " TWILIO_AUTH_TOKEN; echo ""
[[ -n "$TWILIO_AUTH_TOKEN" ]] || fatal "Auth token required"

ask "From Number in E.164 format (e.g. +12125550100)"
read -rp "  > " TWILIO_FROM_NUMBER
[[ "$TWILIO_FROM_NUMBER" == +* ]] || fatal "Number must start with + (E.164)"

section "Make.com Webhook Secret"
ask "Secret string shared between Make.com and Supabase (blank = auto-generate)"
read -rp "  > " MAKE_WEBHOOK_SECRET
if [[ -z "$MAKE_WEBHOOK_SECRET" ]]; then
  MAKE_WEBHOOK_SECRET=$(openssl rand -hex 24 2>/dev/null || cat /dev/urandom | tr -dc 'a-f0-9' | head -c 48)
  success "Generated: ${MAKE_WEBHOOK_SECRET}"
fi

section "Optional"
ask "Slack webhook URL for health alerts (Enter to skip)"
read -rp "  > " SLACK_WEBHOOK_URL
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"

ask "Apify API token for LinkedIn/Zillow scraping (Enter to skip for now)"
read -rp "  > " APIFY_TOKEN
APIFY_TOKEN="${APIFY_TOKEN:-YOUR_APIFY_TOKEN_HERE}"

echo ""
info "Configuration collected. Writing files..."
echo ""

# ── 3. Write dashboard/.env.local ─────────────────────────────────────────────
mkdir -p dashboard
cat > dashboard/.env.local <<EOF
NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
EOF
success "dashboard/.env.local"

# ── 4. Write .env.supabase (edge function secrets) ────────────────────────────
cat > .env.supabase <<EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
MAKE_WEBHOOK_SECRET=${MAKE_WEBHOOK_SECRET}
TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}
TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}
TWILIO_FROM_NUMBER=${TWILIO_FROM_NUMBER}
SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL}
EOF
success ".env.supabase  (edge function secrets)"

# ── 5. Protect secrets in .gitignore ──────────────────────────────────────────
GITIGNORE=".gitignore"
for line in ".env.supabase" "dashboard/.env.local" ".env.local" "*.env"; do
  grep -qxF "$line" "$GITIGNORE" 2>/dev/null || echo "$line" >> "$GITIGNORE"
done
success ".gitignore updated"

# ── 6. Supabase CLI: secrets + migrations ─────────────────────────────────────
if $HAS_SUPABASE; then
  section "Supabase CLI"

  info "Pushing edge function secrets..."
  if supabase secrets set --env-file .env.supabase --project-ref "$SUPABASE_PROJECT_ID" 2>/dev/null; then
    success "Secrets pushed to Supabase"
  else
    warn "Could not push secrets automatically"
    warn "Do it manually: Supabase dashboard → Edge Functions → Secrets"
  fi

  info "Applying database migrations..."
  if supabase db push --project-ref "$SUPABASE_PROJECT_ID" 2>/dev/null; then
    success "Migrations applied"
  else
    warn "Could not apply migrations automatically"
    warn "Run each file in supabase/migrations/ via the SQL editor"
  fi
fi

# ── 7. Install dashboard deps ─────────────────────────────────────────────────
section "Dashboard"
info "Installing npm dependencies..."
(cd dashboard && npm install --silent --prefer-offline 2>/dev/null || npm install --silent)
success "Dependencies installed"

# ── 8. Optional: Vercel deploy ────────────────────────────────────────────────
if $HAS_VERCEL; then
  section "Vercel"
  ask "Deploy dashboard to Vercel now? (y/N)"
  read -rp "  > " DEPLOY_NOW
  if [[ "${DEPLOY_NOW,,}" == "y" ]]; then
    info "Deploying to Vercel (root: dashboard)..."
    (cd dashboard && vercel --yes \
      --env "NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_URL}" \
      --env "NEXT_PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}" \
      --env "SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}" \
      2>&1 | tail -5)
    success "Dashboard deployed"
  fi
fi

# ── 9. Create Supabase auth user ──────────────────────────────────────────────
section "Dashboard login"
ask "Create a dashboard login account? (y/N)"
read -rp "  > " CREATE_USER
if [[ "${CREATE_USER,,}" == "y" ]]; then
  ask "Email for login"
  read -rp "  > " ADMIN_EMAIL
  ask "Password (min 8 chars)"
  read -rsp "  > " ADMIN_PASSWORD; echo ""
  # Call Supabase Auth Admin API
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${SUPABASE_URL}/auth/v1/admin/users" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\",\"email_confirm\":true}" 2>/dev/null)
  if [[ "$HTTP_STATUS" == "200" || "$HTTP_STATUS" == "201" ]]; then
    success "Login created for ${ADMIN_EMAIL}"
  else
    warn "Could not create user automatically (status ${HTTP_STATUS})"
    warn "Create manually: Supabase dashboard → Authentication → Users → Add user"
  fi
fi

# ── 10. Final summary ─────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║  Setup complete — system is configured         ║${NC}"
echo -e "${GREEN}${BOLD}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${DIM}Business:     ${NC}${BOLD}${BUSINESS_NAME}${NC}"
echo -e "${DIM}Markets:      ${NC}${BOLD}${MARKETS}${NC}"
echo -e "${DIM}Project:      ${NC}${BOLD}${SUPABASE_URL}${NC}"
echo -e "${DIM}Make secret:  ${NC}${BOLD}${MAKE_WEBHOOK_SECRET}${NC}"
echo ""

# ── Remaining manual steps ────────────────────────────────────────────────────
STEP=1
echo -e "${BOLD}Remaining steps:${NC}"
echo ""

if ! $HAS_SUPABASE; then
  echo -e "${BOLD}${STEP}. Apply database migrations${NC}"
  echo "   Open supabase.com/dashboard → SQL Editor"
  echo "   Run each file in supabase/migrations/ in order (0000→0004)"
  echo ""
  STEP=$((STEP+1))

  echo -e "${BOLD}${STEP}. Set edge function secrets${NC}"
  echo "   Supabase dashboard → Edge Functions → Secrets"
  echo "   Copy the key=value pairs from .env.supabase"
  echo ""
  STEP=$((STEP+1))
fi

if ! $HAS_VERCEL; then
  echo -e "${BOLD}${STEP}. Deploy dashboard${NC}"
  echo "   a. Push this repo to GitHub"
  echo "   b. vercel.com → New Project → Import repo"
  echo "   c. Set root directory to: dashboard"
  echo "   d. Add env vars from dashboard/.env.local"
  echo ""
  STEP=$((STEP+1))
fi

echo -e "${BOLD}${STEP}. Set Make.com webhook secret${NC}"
echo "   make.com → your team → Settings → Environment Variables"
echo "   Add: MAKE_WEBHOOK_SECRET = ${MAKE_WEBHOOK_SECRET}"
echo ""
STEP=$((STEP+1))

echo -e "${BOLD}${STEP}. Activate Make.com scenarios${NC}"
echo "   Open each ISA scenario (S1–S20) and toggle it ON"
echo "   Note: S1,S5,S12-S15 also need APIFY_TOKEN set in the HTTP module"
if [[ "$APIFY_TOKEN" == "YOUR_APIFY_TOKEN_HERE" ]]; then
  echo "   Get your Apify token at: apify.com/account → Integrations"
fi
echo ""
STEP=$((STEP+1))

echo -e "${BOLD}${STEP}. Wire Twilio inbound SMS${NC}"
echo "   console.twilio.com → Phone Numbers → ${TWILIO_FROM_NUMBER}"
echo "   Messaging → Webhook: https://hook.us2.make.com/7tenjbym1hpxq7s61f5foq929g7paiff"
echo ""
STEP=$((STEP+1))

echo -e "${BOLD}${STEP}. Forward Zillow/Realtor emails${NC}"
echo "   Gmail filter → From: @zillow.com OR @realtor.com"
echo "   Forward to: ukfezgjhxfebpm6f5px91zfjrfk5vifm@hook.us2.make.com"
echo ""
STEP=$((STEP+1))

echo -e "${BOLD}${STEP}. Point your website form to the inbound webhook${NC}"
echo "   POST to: https://hook.us2.make.com/rnad6pwvp8gpnw3hwcqmc852k13fqaha"
echo "   Body: { name, phone, email, inbound_message, segment?, market? }"
echo ""
STEP=$((STEP+1))

if [[ -z "$SLACK_WEBHOOK_URL" ]]; then
  echo -e "${BOLD}${STEP}. (Optional) Enable Slack health alerts${NC}"
  echo "   api.slack.com/apps → Incoming Webhooks → copy URL"
  echo "   Add SLACK_WEBHOOK_URL to Supabase edge function secrets"
  echo ""
  STEP=$((STEP+1))
fi

echo -e "${BOLD}Run locally:${NC}"
echo "   cd dashboard && npm run dev  →  http://localhost:3000"
echo ""
echo -e "${BOLD}Test inbound SMS response:${NC}"
cat <<CURL
   curl -X POST ${SUPABASE_URL}/functions/v1/respond-lead \\
     -H 'x-make-secret: ${MAKE_WEBHOOK_SECRET}' \\
     -H 'Content-Type: application/json' \\
     -d '{"phone":"+12125550100","inbound_message":"Saw your listing, interested in 2BR Brooklyn","channel":"sms"}'
CURL
echo ""
echo -e "${BOLD}Test cadence (dry run — no SMS sent):${NC}"
cat <<CURL
   curl -X POST ${SUPABASE_URL}/functions/v1/follow-up-cadence \\
     -H 'x-make-secret: ${MAKE_WEBHOOK_SECRET}' \\
     -H 'Content-Type: application/json' \\
     -d '{"dry_run":true}'
CURL
echo ""
echo -e "${DIM}Issues? github.com/central-station-33/InRange/issues${NC}"
echo ""
