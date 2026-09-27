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

---

# Uppföljning 2026-09-21 — orsaken hittad, fixen skriven

Analysen ovan hade rätt om *vad* som var dyrt och fel om *var* det kom ifrån.
Den pekade ut `select("*")` i edge-funktionerna. Det var en riktig kostnad, men
det var inte motorn. Motorn var hur ofta anropen skedde.

## Vad som faktiskt drev trafiken

**`hooks/check-messages.py` är en PostToolUse-hook — den kör efter *varje*
verktygsanrop.** Dess egen kommentar sa "Cost: one HTTP request per tool call
(~50ms)". Kostnaden i millisekunder stämde. Kostnaden i byte nämndes inte.

Varje sådant anrop gjorde ett fullt `check`. Uppmätt 2026-09-21:

| Agent | Byte per anrop | Per verktygsanrop |
|---|---:|---|
| ivonne | 4 044 213 | varje gång |
| mimir | 2 491 682 | varje gång |

En session med 200 verktygsanrop kostade alltså ~800 MB — för att visa 200
tecken per meddelande. Hooken laddade ner hela inkorgen, med vektorer, och
kastade 99,9 % av den. Den hade redan en `shown_ids`-fil som visste vilka
meddelanden den sett; den använde den bara för att *dölja* dem efter
nedladdningen, inte för att slippa hämta dem.

Det förklarar båda halvorna av fördelningen. Functions-halvan är hooken. Att
PostgREST-halvan var lika stor beror inte på att hookarna går förbi
funktionerna — `ds.js`, `conductor.js` och `orchestrator.js` använder sin
`createClient` **enbart** för Realtime, de rör aldrig `.from()`. PostgREST-
trafiken kommer från MCP-servern, som körs i varje session, och från Realtime-
publikationen, som sände hela raden inklusive `embedding` till varje ansluten
lyssnare vid varje INSERT.

## Om de 32 `select("*")`

Siffran var en grep-träff, inte en läcka. Av 32 förekomster i 8 funktioner låg
**2** på en tabell med vektorkolumner (`session-start`, rad 235 och 243) utöver
`agent-messages`. De övriga 28 ligger på `users`, `agent_skills`,
`org_governance_profiles`, `repo_files`, `oauth_state` och liknande — tabeller
utan `embedding`. De är inte gratis, men de är inte det här problemet.

Däremot fanns en läcka som inte stod i listan: `.select()` utan argument efter
`insert()`. Den returnerar `*`, så varje skickat meddelande fick tillbaka den
embedding det just skrivit — ~19 kB per `send`.

## Vad som ändrats

**1. Anropsfrekvensen (störst effekt)**
- `hooks/check-messages.py` — golv på 60 s mellan anrop
  (`DESIGN_SPACE_CHECK_INTERVAL`), och `since` så att ett anrop bara hämtar det
  som tillkommit sedan förra. Första anropet i en session hämtar inkorgen, resten
  hämtar nästan ingenting.
- `hooks/ds.js`, `hooks/conductor.js` — samma golv
  (`DESIGN_SPACE_CHECK_FLOOR_MS`) och samma `since`. Reconnect-vägen var den dyra:
  varje återanslutning hämtade hela inkorgen, och en flaxande anslutning
  återanslöt var 30:e sekund.

**2. Vektorerna ut ur svaren**
- `database/supabase/functions/_shared/columns.ts` — en definition av
  "meddelandefält utan vektorer", så nästa `select("*")` inte kan smyga tillbaka in.
- `agent-messages` och `session-start` använder den. Även de tomma `.select()`
  efter `insert()`.
- Migration `032_realtime_drop_vectors.sql` — kolumnlista på
  `supabase_realtime`-publikationen, så Realtime slutar sända vektorer till
  fem anslutna lyssnare vid varje meddelande.

**3. Läst-filtret ner i frågan**
Både `agent-messages` och MCP-serverns `agent_space_check_messages` filtrerade
lästa meddelanden i JavaScript efter nedladdningen. Nu sker det i SQL.

> Fallgrop, verifierad mot data: `metadata->read_by` saknas på 7 rader, och
> `NOT (NULL @> '["x"]')` är NULL — inte TRUE. Ett rakt `not.cs` hade tyst
> tappat exakt de raderna. Filtret har därför en `is.null`-gren.

**4. Listvy utan fulltext**
`check` tar `preview: true` och returnerar då en mager projektion — de fält som
behövs för att ruta och visa, plus 140 tecken innehåll, med `content_length` och
`truncated`. MCP-verktyget hämtar poolen utan `content` och fulltext bara för de
tio det faktiskt visar.

**5. Phase 1 har tak utan att tappa direktmeddelanden**
Kommentaren "no limit — never miss a direct message" hade rätt avsikt. Avsikten
överlever: `check` och `session-start` har tak, men svaret bär `has_more_direct`
och `next_direct_offset`, och hooken skriver ut "[INBOX TRUNCATED]". Paginerat,
inte kapat.

## Uppmätt

| Vad | Före | Efter |
|---|---:|---:|
| `check` ivonne, fullt läge | 4 044 213 B | 453 918 B |
| `check` ivonne, hookens faktiska anrop | 4 044 213 B | 39 325 B |
| `check` ivonne, 182 rader preview | — | 97 006 B |
| MCP `check_messages` | 372 876 B | 80 294 B |

Per anrop är det ~103× för hooken. Ovanpå det kommer frekvensen: 200 anrop per
session blir högst ~40, och alla utom det första returnerar nästan tomt tack
vare `since`.

## Kvar att göra

Allt ovan är skrivet och verifierat mot riktig data, men **inget är
deployat** — `supabase login` är interaktivt och Bitwarden-valvet är låst, så
den här sessionen kunde inte deploya. Tills `agent-messages` och `session-start`
är utrullade och migration 032 körd fortsätter läckan.

1. `supabase functions deploy agent-messages session-start --project-ref uztngidbpduyodrabokm`
2. `supabase db push` (migration 032)
3. Mät om: ett `check` för ivonne ska ligga under 100 kB
4. Dygnsmätning efter ett dygn — egress ska vara i tiotals MB, inte GB

## Arkitekturbeslutet

Frågan om Agent Space ska ligga kvar i Supabase eller flytta till `.md`-filer
i respektive repo är fortfarande inte fattad. Inget här låser det beslutet:
en explicit kolumnlista och ett anropsgolv är rätt i båda världarna.
