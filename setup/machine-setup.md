# Machine Setup — Identical Dev Environment

All WDS machines must have the same repo structure so agents can work
across machines without path translation.

## Directory Structure

All repos live under `c:\dev\` with this exact layout:

```
c:\dev\
├── AgentSpace\agent-space\                  ← whiteport-collective/agent-space
├── Avanza\wds-avanza-course\                ← whiteport-collective/wds-avanza-course
├── Coursely\coursely-concept\               ← whiteport-collective/coursely-concept
├── Kalla-Fordonscervice\kalla-fordonsservice\ ← whiteport-collective/kalla-fordonsservice
├── Månella\manella-webshop\                 ← whiteport-collective/manella-webshop
├── N-Zyte\ugc-app\                          ← N-Zyte-Labs/ugc-app
├── Sharif\                                  ← whiteport-collective/sharif-webshop
├── WDS\
│   ├── bmad-method-wds-expansion\           ← bmad-code-org/bmad-method-wds-expansion
│   ├── design-space\                        ← whiteport-collective/design-space
│   ├── wds-marketing\                       ← whiteport-collective/wds-marketing
│   ├── wds-onboarding-test\                 ← whiteport-collective/wds-onboarding-test
│   ├── whiteport-astro\                     ← whiteport-collective/whiteport-astro
│   └── whiteport-design-studio\             ← whiteport-collective/whiteport-design-studio
├── Web247\web247-team\                      ← web-247/web247-team
├── Whiteport\
│   ├── Social-stream-post\                  ← whiteport-collective/Social-stream-post
│   ├── Whiteport\                           ← whiteport-collective/Whiteport
│   ├── whiteport-astro\                     ← whiteport-collective/whiteport-astro
│   ├── whiteport-site\                      ← whiteport-collective/whiteport-site
│   └── whiteport-team\                      ← whiteport-collective/whiteport-team
├── actimate-app\actimate\                   ← whiteport-collective/actimate
├── agentation\                              ← MartenAngner/agentation
├── bansell-web\anna-bansell-hemsida\        ← Anna-Bansell-Holding/anna-bansell-hemsida
├── bmad-method\
│   ├── BMAD-METHOD\                         ← MartenAngner/BMAD-METHOD
│   ├── BMAD-METHOD-WDS\                     ← whiteport-collective/BMAD-METHOD-WDS
│   ├── BMAD-METHOD-WDS-ALPHA\               ← whiteport-collective/BMAD-METHOD-WDS-ALPHA
│   ├── bmad-agent-space\                    ← whiteport-collective/bmad-agent-space
│   └── bmad-builder\                        ← bmad-code-org/bmad-builder
├── dogweek\dogweek-dev\                     ← whiteport-collective/dogweek-dev
├── karnkraft\karnkraft-concept\             ← whiteport-collective/karnkraft-concept
└── marten-angner\martens-documents\         ← MartenAngner/martens-documents
```

## Clone Script

Run this on a new machine to set up everything:

```bash
mkdir -p c:/dev/{AgentSpace,Avanza,Coursely,Kalla-Fordonscervice,Månella,N-Zyte,WDS,Web247,Whiteport,actimate-app,bansell-web,bmad-method,dogweek,karnkraft,marten-angner}

# WDS core
git clone https://github.com/whiteport-collective/design-space.git c:/dev/WDS/design-space
git clone https://github.com/whiteport-collective/whiteport-design-studio.git c:/dev/WDS/whiteport-design-studio
git clone https://github.com/whiteport-collective/whiteport-astro.git c:/dev/WDS/whiteport-astro
git clone https://github.com/bmad-code-org/bmad-method-wds-expansion.git c:/dev/WDS/bmad-method-wds-expansion
git clone https://github.com/whiteport-collective/wds-marketing.git c:/dev/WDS/wds-marketing
git clone https://github.com/whiteport-collective/wds-onboarding-test.git c:/dev/WDS/wds-onboarding-test

# Client projects
git clone https://github.com/whiteport-collective/kalla-fordonsservice.git c:/dev/Kalla-Fordonscervice/kalla-fordonsservice
git clone https://github.com/whiteport-collective/sharif-webshop.git c:/dev/Sharif
git clone https://github.com/whiteport-collective/manella-webshop.git c:/dev/Månella/manella-webshop
git clone https://github.com/whiteport-collective/wds-avanza-course.git c:/dev/Avanza/wds-avanza-course
git clone https://github.com/whiteport-collective/coursely-concept.git c:/dev/Coursely/coursely-concept
git clone https://github.com/whiteport-collective/karnkraft-concept.git c:/dev/karnkraft/karnkraft-concept
git clone https://github.com/N-Zyte-Labs/ugc-app c:/dev/N-Zyte/ugc-app

# Whiteport agency
git clone https://github.com/whiteport-collective/Whiteport.git c:/dev/Whiteport/Whiteport
git clone https://github.com/whiteport-collective/whiteport-astro.git c:/dev/Whiteport/whiteport-astro
git clone https://github.com/whiteport-collective/whiteport-site.git c:/dev/Whiteport/whiteport-site
git clone https://github.com/whiteport-collective/whiteport-team.git c:/dev/Whiteport/whiteport-team
git clone https://github.com/whiteport-collective/Social-stream-post.git c:/dev/Whiteport/Social-stream-post
git clone https://github.com/web-247/web247-team.git c:/dev/Web247/web247-team

# BMad
git clone https://github.com/MartenAngner/BMAD-METHOD.git c:/dev/bmad-method/BMAD-METHOD
git clone https://github.com/whiteport-collective/BMAD-METHOD-WDS.git c:/dev/bmad-method/BMAD-METHOD-WDS
git clone https://github.com/whiteport-collective/BMAD-METHOD-WDS-ALPHA.git c:/dev/bmad-method/BMAD-METHOD-WDS-ALPHA
git clone https://github.com/whiteport-collective/bmad-agent-space.git c:/dev/bmad-method/bmad-agent-space
git clone https://github.com/bmad-code-org/bmad-builder.git c:/dev/bmad-method/bmad-builder

# Other
git clone https://github.com/whiteport-collective/dogweek-dev.git c:/dev/dogweek/dogweek-dev
git clone https://github.com/whiteport-collective/actimate.git c:/dev/actimate-app/actimate
git clone https://github.com/whiteport-collective/agent-space.git c:/dev/AgentSpace/agent-space
git clone https://github.com/MartenAngner/agentation.git c:/dev/agentation
git clone https://github.com/Anna-Bansell-Holding/anna-bansell-hemsida.git c:/dev/bansell-web/anna-bansell-hemsida
git clone https://github.com/MartenAngner/martens-documents.git c:/dev/marten-angner/martens-documents
```

## Post-Clone Setup

### Design Space runner (ds.js)
```bash
cd c:/dev/WDS/design-space/hooks
npm install
```

Add to `.env` (repo root):
```env
MACHINE_NAME=stockholm
```

### Node.js & npm
- Install Node.js 22+ (LTS)
- Install Claude Code: `npm install -g @anthropic-ai/claude-code`

### Git
- Configure SSH keys for GitHub
- `git config --global user.name "Mårten Angner"`
- `git config --global user.email "marten@angner.se"`

### Task Scheduler
- Create task: "Design Space Runner"
- Trigger: At system startup
- Action: Run `c:\dev\WDS\design-space\hooks\start-ds.bat`
- Settings: Restart on failure (1 min delay)

---

*Updated: 2026-03-23*
