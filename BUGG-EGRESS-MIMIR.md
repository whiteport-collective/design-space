---
id: bugg-egress-001
datum: 2026-09-21
from_agent: ivonne
to_agent: mimir
message_type: handoff
project: design-space
prioritet: hög
repo: C:\dev\WDS\design-space
rubrik: "Egress-läckan — 32 select(\"*\") drar med 1536-dimensionella vektorer till klienter som inte vill ha dem"
---

# Buggrapport: egress-läckan i Design Space

**Till:** Mimir
**Från:** Ivonne
**Repo:** `C:\dev\WDS\design-space`
**Läs först:** `EGRESS-INCIDENT-2026-09-18.md` i repo-roten — den har grundanalysen och fältmätningen. Den här rapporten bygger på den och lägger till vad som ändrats sedan dess.

---

## Sammanfattning

`select("*")` mot tabellen `agent_space` skickar med kolumnerna `embedding vector(1536)` och `visual_embedding vector(1024)` till klienter som bara vill veta vem som skrivit vad. Vektorerna är **86 % av svaret**.

Det brände 15,25 GB mot 5 GB fri nivå och strypte projektet 18–21 september.

---

## Vad som ändrats sedan incidentrapporten

**Pro är köpt.** Tjänsten är uppe sedan i dag. Det betyder tre saker:

1. **Ordningsregeln i incidentrapporten gäller inte längre.** Den sa "fixa först, exportera sedan". Exporten är gjord — 195 meddelanden ligger på disk i `whiteport-agent-space/handovers/`. Du kan alltså arbeta fritt utan att bränna nästa kvot.
2. **Det är inte längre akut, men det är fortfarande fel.** 250 GB tak i stället för 5 räcker länge. Men en inkorgsöppning ska inte kosta 4 MB.
3. **Det kostar nu pengar varje månad.** Det är en del av skälet att laga det.

**Färsk mätning i dag, 2026-09-21:** ett `check`-anrop mot `agent-messages` för agent `ivonne` returnerade **3 870 660 byte för 195 meddelanden**. I ett enskilt meddelande: `embedding` 19 236 tecken mot `content` 3 302.

---

## Omfattningen är större än incidentrapporten antog

Den pekade ut två rader i en funktion. Hela kodbasen har **32 förekomster av `select("*")` i 8 edge-funktioner**:

| Funktion | Antal |
|---|---:|
| `identity-access` | 9 |
| `agent-messages` | 7 |
| `governance` | 6 |
| `open-glass-briefings` | 3 |
| `agent-instructions` | 3 |
| `session-start` | 2 |
| `repo-files` | 1 |
| `tool-oauth` | 1 |

Alla är inte lika allvarliga — bara frågor mot tabeller som faktiskt har vektorkolumner drar den stora kostnaden. Men `select("*")` är fel som mönster överallt: det gör svaret beroende av schemat, så nästa kolumn någon lägger till hamnar automatiskt i alla svar.

**Värst är `agent-messages/index.ts`:**

- **Rad 138** — Phase 1, `select("*")` **utan `.limit()`**. Kommentaren på rad 135 säger *"no limit — never miss a direct message"*. Välmenat, men varje session hämtar hela historiken med vektorer.
- **Rad 148** — Phase 2, `select("*")` med limit som bara gäller den fasen.
- **Rad 165–185** — läst-filtret körs i JavaScript **efter** nedladdningen. Lästa meddelanden kostar full egress ändå.

---

## Fix

Från incidentrapporten, fortfarande giltig:

1. **Explicit kolumnlista i stället för `select("*")`.** Aldrig `embedding` eller `visual_embedding` utom i sökfunktionerna, som är de enda som behöver dem.
2. **`.limit()` även på Phase 1.** Tak på 50 med paginering.
3. **Flytta läst-filtret till frågan** i stället för att filtrera i JS efteråt.
4. **Utelämna `content` i listvyer.** Hämta fulltext först när någon öppnar ett meddelande.

Punkt 1 ensam tar 4,77 MB → ~650 kB. Alla fyra tillsammans: några kB per anrop.

**Förslag värt att väga:** en databasvy eller en delad hjälpfunktion i `_shared` som definierar "meddelandefält utan vektorer" på ett ställe. Då kan inte nästa `select("*")` smyga tillbaka in. Det är ditt beslut — du äger bygget.

---

## Rotorsaken: hookarna pollar — börja här

Incidentrapporten noterade att egressen var jämnt fördelad — **PostgREST 1,266 GB (50,2 %) mot Functions 1,255 GB (49,8 %)** — men lämnade PostgREST-halvan outredd. Jag spårade den. **Det är inte en halva, det är motorn.**

`hooks/ds.js` och `hooks/conductor.js` är långkörande daemoner, inte engångshookar. De gör två saker som multiplicerar den feta endpointen:

**1. `checkUnread()` avfyras vid varje återanslutning.**

```
ds.js:289   checkUnread()  →  action: 'check'   // hela inkorgen, 3,87 MB
ds.js:683   setInterval(...)                     // realtime-tillstånd pollas
ds.js:693   await checkUnread()                  // vid varje reconnect
```

Flaxar realtime-anslutningen hämtas alltså hela inkorgen med vektorer **per återanslutning**. En instabil uppkoppling blir en egress-kran.

**2. En 30-sekunderspuls per session.**

```
ds.js:420   setInterval(..., 30000)   // "Post digest every 30 seconds"
```

Plus `setInterval(watchdog, 5 * 60 * 1000)` på rad 714.

**3. PostgREST-halvan har sin förklaring.** `ds.js:624` och `conductor.js:595` bygger var sin `createClient(SUPABASE_URL, SUPABASE_KEY)`. Den klienten går rakt mot databasen — inte via edge-funktionerna. Det är den trafiken som syns som PostgREST i statistiken.

Ytterligare **13 filer utanför `supabase/functions/` bygger egna klienter**: `channel/design-space.ts`, `hooks/{conductor,ds,orchestrator}.js`, `integrations/fireflies/{backfill.py,sync.ts}`, `mcp-server/index.js`, `mcp-server/agent-space-mcp/index.js`, tre plugin-stubbar, `tools/sync-instructions.js`, `tools/wrap-publish.py`.

### Varför det här är rätt ände att börja i

Kolumnlistorna gör varje anrop billigare. **Hookarna avgör hur många anrop som sker.** En fet endpoint som anropas två gånger om dagen kostar ingenting; samma endpoint i en pollingloop kostar 15 GB.

Jag såg dem köra i sessionen där den här rapporten skrevs: en hook returnerade en förhandsvisning av **189 meddelanden**, alltså en full hämtning, mitt under arbetet.

**Konkret ordning jag föreslår:**

1. Ta bort eller strypa `checkUnread()` i reconnect-loopen — den ska hämta *nya* meddelanden sedan en tidsstämpel, inte hela inkorgen.
2. Lägg ett golv på hur ofta en hook får anropa `check` alls.
3. **Sedan** kolumnlistorna.

Punkt 1 och 2 är sannolikt större än alla 32 `select("*")` tillsammans.

---

## Acceptanskriterier

- Ett `check`-anrop mot `agent-messages` för en agent med ~200 meddelanden returnerar **under 100 kB**.
- Inget svar innehåller `embedding` eller `visual_embedding` utom från sökfunktionerna.
- Phase 1 har ett tak och paginering, utan att direktmeddelanden kan tappas bort — den ursprungliga avsikten i kommentaren på rad 135 ska överleva.
- Ingen hook kan hämta hela inkorgen i en loop. `checkUnread()` hämtar nytt sedan en tidsstämpel, inte allt.
- En dygnsmätning efter fixen visar egress i storleksordningen tiotals MB, inte GB.

---

## Rör inte

- **Sökfunktionerna behöver sina vektorer.** `search-design-space`, `search-knowledge`, `search-visual-similarity` och `search-preference-patterns` ska fortsätta läsa `embedding`. Kapa inte dem på vägen.
- **ivfflat-indexen i migration 001** hör till sökningen, inte till läckan.
- **Direktmeddelanden får inte tappas.** Kommentaren på rad 135 finns av ett skäl: en agent som missar ett direktmeddelande märker det inte. Paginera, kapa inte.

---

## Kontext som kan påverka hur du löser det

Ett arkitekturbeslut är under mognad men **inte fattat**: om Agent Space överhuvudtaget ska ligga kvar i Supabase, eller om meddelanden och överlämningar hör hemma som `.md`-filer med frontmatter i respektive repo — en fil per meddelande, maildir-mönstret.

Exporten i dag var ett steg i den riktningen, men bara som säkerhetskopia.

**Låt det inte blockera dig.** Läckan ska lagas oavsett vilket, och en explicit kolumnlista är rätt i båda världarna. Men om du står inför ett val mellan en liten fix och en stor omskrivning: ta den lilla. Den stora frågan är Mårtens, inte din.
