# Egress-incident 2026-09-18 — projektet strypt

**Status:** Projektet är strypt sedan 18 september. 402 på REST, edge functions
och auth. Quotan vänder **27 september** (cykel 27 aug – 27 sep).

---

## Vad som hände

Förbrukat **15,25 GB egress** mot **5 GB** på fri nivå. Tre gånger över.

Databasen är 155 MB. Samma data har alltså hämtats ungefär hundra gånger om.

| Dygn | Egress |
|---|---:|
| Värsta (17 sep) | **2,5 GB** — halva månadskvoten på ett dygn |
| Fördelning | PostgREST 1,266 GB (50,2 %) · Functions 1,255 GB (49,8 %) |

Att det är jämnt fördelat betyder att **halva trafiken går förbi
edge-funktionerna**, rakt mot databasen via REST. Att bara laga funktionerna
räcker inte.

## Orsaken, mätt

Ett `check`-anrop mot `agent-messages` returnerade **4,77 MB** för 242
meddelanden. Fältfördelning i det faktiska svaret:

| Fält | Bytes | Andel |
|---|---:|---:|
| **`embedding`** | **4 211 021** | **86,1 %** |
| `content` | 577 295 | 11,8 % |
| `metadata` | 41 370 | 0,8 % |
| allt annat | ~56 000 | 1,1 % |

`agent_space` har `embedding vector(1536)` och `visual_embedding vector(1024)`
(migration 001). **`select("*")` skickar med båda** — till klienter som bara
vill veta vem som skrivit vad.

## Var i koden

`supabase/functions/agent-messages/index.ts`:

- **Rad 138** — Phase 1: `.select("*")` utan `.limit()`. Kommentaren på rad 135
  säger *"no limit — never miss a direct message"*. Välmenat, men det betyder att
  varje session hämtar hela historiken med vektorer.
- **Rad 148** — Phase 2: `.select("*")`, limit finns men gäller bara den här fasen.
- **Rad 165–185** — filtreringen av redan lästa meddelanden sker i JavaScript,
  *efter* nedladdningen. Lästa meddelanden kostar alltså full egress ändå.

Samma mönster finns sannolikt i fler funktioner — sök efter `select("*")`.

## Fix

1. **Byt `select("*")` mot explicit kolumnlista.** Aldrig `embedding` eller
   `visual_embedding` utom i sökfunktionerna. Ensamt: 4,77 MB → ~650 kB.
2. **Sätt `.limit()` även på Phase 1.** Ett tak på 50 med paginering.
3. **Flytta läst-filtret till frågan** i stället för att filtrera i JS efteråt.
4. **Utelämna `content` i listvyer.** Hämta fulltext först när någon öppnar.

Tillsammans: från ~4,8 MB till några kB per anrop.

## ⚠️ Ordningen spelar roll

Du kommer inte åt din egen data förrän tjänsten är tillbaka den 27:e.

**Fixa `select("*")` först, exportera sedan.** Görs det i omvänd ordning bränner
exporten nästa månads kvot på första anropet, och projektet släcks ner igen
samma dag.

## Bakgrund

Upptäcktes när `tool-gmail` slutade svara mitt under Essentias bokföring
2026-09-18. Full kontext i
`martens-documents/Planning/Handovers/2026-09-18-ivonne-essentia-bokforing.md`.

Diskussionen ledde vidare till frågan om Agent Space överhuvudtaget ska ligga
i Supabase, eller om överlämningar och meddelanden hör hemma som `.md`-filer
i respektive repo. Det beslutet är inte fattat.
