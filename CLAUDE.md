# CLAUDE.md — hls-lens

Estensione VS Code **HLS Lens** (`github.com/Allan-Nava/hls-lens`): lettura di manifest HLS nell'editor — diagnostics inline sulle playlist m3u8, ladder come albero, document link sugli URI, fetch di un manifest da URL e deep check dei segmenti delegato a [segcheck](https://github.com/Allan-Nava/segcheck). TypeScript + esbuild, **zero dipendenze runtime**.

Filosofia: le regole leggono le *dichiarazioni* del manifest e puntano alla riga da correggere; tutto ciò che richiede i byte dei segmenti si delega a segcheck, non si reimplementa qui.

## Regole di lavoro (SEMPRE)

- **Ogni commit = release taggata `vX.Y.Z`**: nuova sezione in `CHANGELOG.md` (Keep a Changelog, in italiano) + `git tag -a vX.Y.Z -m "Release X.Y.Z"`. Bump `minor` per novità sostanziali (nuove regole, nuove feature editor), `patch` per fix. Senza chiederlo. Il campo `version` di `package.json` deve coincidere col tag (vsce lo pretende).
- **MAI `git push`** — lo fa sempre l'utente. MAI `Co-Authored-By` nei commit.
- **Un tag `v*` pushato pubblica sugli store** (job `publish` in `ci.yml`: Marketplace + Open VSX, con il `.vsix` esatto allegato alla release). Combinato con la regola "ogni commit = release taggata", significa che ogni push di un tag arriva agli utenti: la versione si bumpa con intenzione, e il `CHANGELOG.md` è la release note. Senza `VSCE_PAT`/`OVSX_PAT` nell'environment `marketplace` il job avvisa e salta, non fallisce.
- **Gate prima di chiudere**: `npm run typecheck` + `npm test` + `npm run docs` + `npm run roadmap` (gli ultimi due devono essere un no-op) + `npm run icon:check` verdi. Stessi check della CI.
- **La logica va nel core puro** (`src/core/` — MAI import `vscode` lì) con test in `test/run.ts`; `src/extension.ts` è solo glue UI (non testata).
- **TDD stretto, sempre**: per ogni logica nuova o modificata, scrivere prima il test e **verificare il RED** *prima* di implementare, poi portarlo a GREEN. Vale anche per i generatori e per il tooling di build: se una cosa è logica, va in `src/core/` (bundlata negli script dalla mappa `TOOLS` di `esbuild.mjs`) e ha un test in `test/run.ts`, e lo script resta glue di I/O. **Solo** la UI glue di `src/extension.ts` è esente, per scelta.
- **Ogni regola nuova**: entra in `src/core/analyze.ts` con id stabile `categoria/nome`, voce in `RULES` (con `severity`, `title` e un `rationale` che spiega il *rischio*, non ripete il titolo), test nel file dei test, `npm run docs` per rigenerare `docs/RULES.md`, voce nel `CHANGELOG.md`.
- **Gli id delle regole sono API**: chi mette l'estensione in un team pinna un id in `hlsLens.diagnostics.skip`. Non rinominarli senza una major e una nota nel changelog.
- **Niente rete nei test**: fixture in `test/fixtures/`, server `http` usa-e-getta su porta random per il fetcher, contratto JSON di segcheck testato **senza** lanciare il binario. Un test che tocca un CDN reale è un bug.
- **Todo → `BACKLOG.md`** (sorgente unica, id stabili `HL-n`). Non sparpagliare TODO nei commenti. **Il formato è load-bearing**: `## Milestone` → milestone GitHub, `### Area` → raggruppamento, `- [ ] **HL-n — Titolo**: descrizione` → issue. Chiudere una voce = `- [x]`, mai cancellarla. **Le sezioni sono di due tipi**: quelle *consegnate* prendono il nome del tag che le ha spedite (`## v0.3.0 — Publishing automation`, tutte le voci checkate → la milestone si chiude), quelle *pianificate* prendono il nome del tema (`## Editor`). Quando una voce esce, si **sposta** dalla sezione tematica a quella della release: una issue GitHub ha **una** sola milestone, e spostare la voce è il solo modo di rispondere sia "in che release è uscita" sia "di che tema è". Una release di sola documentazione non apre una sezione — per quello c'è il `CHANGELOG.md`. Dopo ogni modifica al backlog: `npm run roadmap` (rigenera `docs/ROADMAP.md`, gate in CI). Le issue su GitHub sono un mirror generato: si edita il file, non l'issue.
- **Documentare tutto nello stesso commit**: ogni novità va riflessa in `README.md` (feature, comandi, settings), in `docs/` e nel `CHANGELOG.md`. `docs/RULES.md` è **generato**: si modifica il catalogo, non il file.
- **Lingua = inglese**: codice, commenti, test e tutto l'output user-facing (messaggi dei finding, titoli dei comandi, descrizioni delle settings, README, docs). **Eccezione: il `CHANGELOG.md` resta in italiano.**

## Comandi

```bash
npm install
npm run build            # bundle esbuild → dist/extension.js
npm run watch            # watch mode; poi F5 apre l'Extension Host
npm test                 # core: parser, regole, ladder, URI, bridge segcheck, fetcher
npm run typecheck        # esbuild non typecheckka
npm run docs             # rigenera docs/RULES.md dal catalogo (gate in CI)
npm run roadmap          # rigenera docs/ROADMAP.md da BACKLOG.md (gate in CI)
npm run backlog:sync     # milestone + issue GitHub da BACKLOG.md; in CI lo fa il workflow
                         # locale: GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=Allan-Nava/hls-lens DRY_RUN=1 npm run backlog:sync
npm run icon             # rigenera media/icon.png da primitive
npm run icon:check       # verifica i PIXEL del PNG committato contro il generatore (gate in CI)
npm run site             # costruisce site/ da docs/ (quello che pubblica Pages; site/ NON si committa)
npm run package          # .vsix locale (vsce --no-dependencies)

# Prova rapida sulle fixture, senza Extension Host
code test/fixtures/media-live-broken.m3u8   # 6 regole devono accendersi
code test/fixtures/media-ll-broken.m3u8     # le 5 regole low latency della fixture
```

## Architettura

- `src/core/attrs.ts` — attribute list di RFC 8216 §4.2 parsate carattere per carattere, più gli accessor tipati (`attrInt`, `attrFloat`, `attrResolution`, `attrList`, `attrBool`).
- `src/core/playlist.ts` — parser: `Playlist` con `variants`, `renditions`, `segments`, `keys`, `maps`, `serverControl`, il vocabolario low latency (`parts`, `partTarget`/`partInfLine`, `preloadHints`, `renditionReports`), le variabili (`defines`, `variables`, `variableRefs`, **sostituite in ingresso** negli URI e negli attributi), gli EXTINF/STREAM-INF orfani e **l'indice di riga di tutto** (0-based). Set dei tag noti (per `syntax/unknown-tag`) e dei tag con attribute list. Le `parts` stanno per conto loro e non appese al `Segment`: una parte viene pubblicata *prima* del segmento che la contiene, che potrebbe non essere mai scritto.
- `src/core/analyze.ts` — le regole su singolo file (61) + le 9 `cross/*` documentate qui e implementate in `crosscheck.ts` + `RULES` (il catalogo documentato) + la tabella `VERSION_REQUIREMENTS` tag→versione minima. Ordine dei finding: severità, poi riga.
- `src/core/ladder.ts` — modello dell'albero (`buildLadder`, `renditionRows`, `ladderSummary`) e formattazione (`formatBandwidth`, `formatResolution`).
- `src/core/uri.ts` — `resolveUri`/`baseOf`/`isRemote`/`isPlainHttp`/`looksLikePlaylistUri`/`looksLikeFmp4Uri`.
- `src/core/crosscheck.ts` — `analyzeAcross`: le regole che servono il master e le sue rendition insieme (versione, target duration, conteggio segmenti, drift delle boundary, discontinuità, finestra live, BANDWIDTH vs EXT-X-BITRATE, EXT-X-SESSION-KEY vs le chiavi vere). Il master arriva in `options.master`, opzionale: tutte le altre regole confrontano rendition con rendition e non ne hanno bisogno. I finding si ancorano alla riga dell'`EXT-X-STREAM-INF` nel master, che è il file aperto.
- `src/core/markdown.ts` — il sottoinsieme di markdown che i documenti usano davvero (heading, liste, tabelle pipe, code fence, inline, link) più `renderPage`. Tutto escapato di default, code span estratti **prima** dell'emphasis con sentinella `\u0000` (un asterisco dentro un id di regola non è corsivo), output deterministico. Non è una dipendenza per lo stesso motivo di `xml.ts`.
- `src/core/xml.ts` — lettore XML minimo (elementi, attributi, annidamento, indici di riga 0-based). Non fa entity expansion oltre le cinque predefinite, né DTD né namespace: un MPD che ne ha bisogno viene **segnalato**, non indovinato. Non è una dipendenza per lo stesso motivo per cui non ce ne sono altre.
- `src/core/dash.ts` — `parseIsoDuration` e `analyzeMpd`: le 11 regole `dash/*` (timeline, durata dichiarata, UTCTiming, allineamento, template). Le voci del catalogo stanno in `analyze.ts` come tutte le altre.
- `src/core/watch.ts` — `diffPlaylists` (segmenti matchati per **URI**, non per indice: l'indice cambia a ogni scorrimento della finestra), `describeChange` e `watchIntervalMs` (target duration, con pavimento a 2s). Nessun clock e nessuna rete: il polling lo fa la glue.
- `src/core/mpdtree.ts` — l'MPD come albero: `buildMpdTree` (periodi → adaptation set → representation, con l'indice di riga di ognuno) e `mpdSummary` per la status bar. Riusa `formatBandwidth` di `ladder.ts` così un rung DASH e un rung HLS si leggono uguali.
- `src/core/workspace.ts` — la scansione del workspace come dato: `isManifestPath`, `summariseWorkspace` (conteggi e ranking: errori, poi warning, poi hint, poi **path** — l'ultimo criterio è ciò che rende due scansioni dello stesso albero diffabili) e `renderWorkspaceReport`, che quando tronca **dice** quanti file ha lasciato fuori. Leggere i file resta glue.
- `src/core/timeline.ts` — la timeline come dato e come pagina: `buildTimeline` (segmenti in fila, discontinuità, `EXT-X-GAP`, gli ad break dei `DATERANGE` **solo** se c'è un `PROGRAM-DATE-TIME` che li ancora), `niceTicks` e `renderTimelineHtml`, che rende **tutta** la pagina come stringa. È il motivo per cui una webview ha dei test: la glue crea il pannello, setta l'html e ritrasforma un click in una riga. Le righe fuori passo sono la **minoranza** del cluster di boundary, non tutte quelle coinvolte.
- `src/core/spec.ts` — la specifica come dato: `SPEC_TAGS` (scope, versione minima, sintesi, attributi con i valori enumerati), `tagSpec`, `renderTagHover` e `completeAt`. Un test incrocia questo elenco con `KNOWN_TAG_NAMES` del parser nei due sensi.
- `src/core/fixes.ts` — `quickFixesFor`: solo i finding meccanici (versione, ENDLIST, target duration) come edit di riga; la glue li trasforma in `WorkspaceEdit`.
- `src/core/backlog.ts` — `BACKLOG.md` come dato: `parseBacklog`, `duplicateIds`, `sectionState`, `backlogStats`, `renderRoadmap`, `orphanMilestones` e la mappatura verso le issue (`markerOf`/`idFromBody`/`issueTitle`/`issueBody`). Non c'entra con l'estensione: sta nel core perché è logica, e la logica si testa.
- `src/core/segcheck.ts` — `buildSegcheckArgs` e il parsing del JSON di segcheck (`worst`, `summary`, `findings[]` con `check`/`target`/`status`/`message`/`hint`), mappato su `Finding`.
- `src/core/fetch.ts` — fetch su `node:http(s)` con redirect, timeout, cap sul body; restituisce anche l'URL **finale**.
- `src/extension.ts` — glue: diagnostics (debounce 300ms), `TreeDataProvider`, `DocumentLinkProvider`, `HoverProvider`, `CompletionItemProvider`, `CodeActionProvider`, `TextDocumentContentProvider` per lo schema `hls-lens:`, status bar, spawn di segcheck, il `WebviewPanel` della timeline (singleton, `enableScripts` con nonce e `localResourceRoots: []`).
- `src/core/png.ts` — l'icona come dato: `drawIcon` (il mark disegnato da primitive, deterministico), `encodePng`/`decodePng` (8-bit RGBA, filtro 0, un IDAT) e `comparePixels`. Sta nel core perché è logica, e la logica si testa.
- `scripts/gen-docs.ts` → `docs/RULES.md` · `scripts/gen-roadmap.ts` → `docs/ROADMAP.md` · `scripts/backlog-sync.ts` → milestone/issue · `scripts/make-icon.ts` → `media/icon.png` (con `--check`, il gate sui pixel). Tutti bundlati da `esbuild.mjs` (mappa `TOOLS`): sono glue di I/O sopra il core.

## Trappole note / regole tecniche

- **Gli indici di riga sono 0-based in tutto il core** (come `vscode.Position`). Convertire in due posti diversi è il modo in cui entra un off-by-one nei squiggle.
- **`CODECS` ha le virgole dentro**: mai `split(',')` su una riga di tag. C'è un test che lo copre.
- **`Math.round(duration) > targetDuration`** è la condizione di `media/extinf-exceeds-target`: la spec parla di durata *arrotondata all'intero*, quindi 5.76s con target 6 è legale e 8.5s no.
- **`totalDuration` è arrotondato al millisecondo**: `6+6+6+6+5.76` in binario fa `29.759999999999998`, e una durata illeggibile è peggio di una arrotondata al millisecondo che il manifest esprime comunque.
- **`hint` → `DiagnosticSeverity.Information`**, non `Hint`: un Hint vero è visibile solo col cursore sulla riga, quindi le regole consultive sparirebbero dal pannello.
- **La scansione del workspace ha la sua `DiagnosticCollection`** (`hls-lens-workspace`), e `updateDiagnostics` la **svuota per quel documento** appena il file viene aperto: le diagnostics vive sono autorevoli, e senza quella cancellazione il pannello Problems mostrerebbe ogni finding due volte.
- **I finding di segcheck vanno in una `DiagnosticCollection` separata** (`hls-lens-segcheck`): quella del manifest viene riscritta a ogni edit e li cancellerebbe. Ancorano a riga 0 con il target nel messaggio, perché i byte incriminati sono in un segmento, non nella playlist.
- **L'URL di origine di un documento fetchato sta nella query dell'URI virtuale** (`hls-lens:host/path?url=…`), non in una mappa: dopo un redirect è l'unico modo per risolvere i figli senza stato che diventa stantio. Il path finisce in `.m3u8` così il linguaggio (e con esso le diagnostics) si applica.
- **`flag`-like: il bundle di test è ESM** e non ha `require`/`__dirname`: li reintroduce il banner in `esbuild.mjs`. Aggiungendo un altro entry point ESM, riusare `nodeBanner`.
- **`workspaceContains:**/*.m3u8` è l'unico `activationEvent` dichiarato**: `onLanguage:m3u8` lo genera VS Code dal contributo `languages` e dichiararlo a mano è un warning.
- **`--insecure` di segcheck esiste per i lab self-signed**, non per silenziare un problema di certificati in produzione.
- **`renderRoadmap` deve restare deterministico**: il gate in CI lo rigenera e fa il diff col file committato, quindi una data, un contatore o qualunque input ambientale nel roadmap fa fallire la build su un run che non ha cambiato niente. Lo stesso vale per `issueBody`: il sync confronta il body renderizzato con quello su GitHub, e qualcosa di variabile lì dentro riscriverebbe tutte le issue a ogni push.
- **Le chiavi composte usano `GROUP_KEY_SEPARATOR = '\\u0000'`** (tipo `AUDIO\\u0000group-id`): un `GROUP-ID` può legittimamente contenere spazi o slash, quindi il separatore deve essere un carattere che un valore di attributo non può avere. Va scritto come **escape** e non come byte letterale: un NUL vero nel sorgente è invisibile in ogni diff e tronca la riga in metà dei tool da terminale (`sed`, `awk`) — cosa che è già costata una ricerca a vuoto.
- **La sostituzione delle variabili avviene nel parser, una volta**: `{$name}` viene risolto mentre si legge, quindi tutto a valle vede l'URI che verrà richiesto. Un nome non dichiarato resta scritto com'è (graffe incluse) perché è *esattamente* quello che il player chiede: sostituire un placeholder vuoto nasconderebbe il difetto. `EXT-X-DEFINE` è esente dalla sostituzione, e i riferimenti si raccolgono in `variableRefs` **prima** di sostituire — per i tag con attribute list si sostituisce solo negli attributi e non anche in `tag.value`, altrimenti ogni riferimento verrebbe contato due volte.
- **La webview non carica niente**: la pagina è una stringa costruita in `src/core/timeline.ts`, con CSP `default-src 'none'` e `localResourceRoots: []`. Il nonce dello script lo passa la glue (`randomBytes`), non il core: `renderTimelineHtml` deve restare deterministico per essere testabile, e un nonce generato lì dentro lo renderebbe diverso a ogni chiamata. `style-src` è `'unsafe-inline'` perché le barre si posizionano con `style="left:…%"` e un nonce non copre gli attributi di stile.
- **Le diagnostics hanno `source = 'hls-lens'`** (minuscolo, con trattino): il provider dei quick fix filtra su quella stringa, e scriverla diversamente fa sparire i fix senza nessun errore.
- **L'icona PNG è generata**: non sostituirla con un binario opaco, si rigenera con `npm run icon` (`src/core/png.ts`: encoder PNG su `zlib`, supersampling 4x per l'antialiasing). **Il gate confronta i pixel, non i byte** (`npm run icon:check`): l'output DEFLATE non è fissato dal formato, quindi lo zlib del runner Linux ricomprime la stessa immagine in byte diversi da quelli scritti su macOS — un `git diff` sul PNG rigenerato faceva fallire la CI a ogni run senza che fosse cambiato niente. Vale per qualunque altro artefatto binario generato che venisse aggiunto.

## Puntatori

- Backlog: `BACKLOG.md` · CI: `.github/workflows/ci.yml` · Sync backlog: `.github/workflows/backlog-sync.yml` · Sito: `.github/workflows/pages.yml` · Generati: `docs/RULES.md`, `docs/ROADMAP.md`, `site/` (non committato)
- Fixture: `test/fixtures/` (`master-clean`, `master-broken`, `media-vod-clean`, `media-live-broken`, `media-ll-broken`, `dash-broken.mpd`)
- Binario delegato: `~/projects/github.com/segcheck` (contratto JSON in `internal/output/output.go`)
- Repo gemelli (stesso scaffold): `~/projects/github.com/nats-lens`, `nomad-lens`, `ansible-vars-lens`
