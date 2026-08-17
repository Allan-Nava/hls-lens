# Changelog

Tutte le modifiche rilevanti a questa estensione sono documentate qui.
Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il progetto usa il [Semantic Versioning](https://semver.org/lang/it/).

## [0.7.0] - 2026-08-17

Guardare uno stream muoversi, invece di fotografarlo.

### Aggiunto

- **Live watch** (HL-13): `HLS Lens: Watch Live Playlist` ricarica un manifest aperto da URL all'intervallo che la playlist stessa dichiara (`EXT-X-TARGETDURATION`, con **pavimento a 2 secondi** perché una playlist low-latency che dichiara 1s non deve trasformare il watch in un load test sull'edge di qualcuno) e dice cosa è cambiato: i segmenti nuovi, quanti sono usciti dalla finestra, una discontinuità comparsa, un `EXT-X-ENDLIST` arrivato — e in quel caso si ferma da solo. Una **finestra che non si muove per due ricariche** viene segnalata: è il packager che si è fermato, e in una singola fotografia è indistinguibile da uno stream sano. La status bar mostra `$(eye) watching` col conteggio degli stalli, e cliccarla ferma il watch.
  Il diff sta nel core (`src/core/watch.ts`), senza clock e senza rete: **i segmenti si confrontano per URI, non per indice**, perché l'indice cambia a ogni scorrimento della finestra e un packager che rinumera farebbe risultare nuova tutta la finestra.
- **Deep check su una rendition sola** (HL-14): click destro su un gradino nell'albero → `HLS Lens: Deep Check This Rendition`, che punta segcheck a quell'URL risolto invece che a tutto il master. Il comando esistente ora accetta un URL preimpostato invece di chiederlo sempre.
- Setting **`hlsLens.watch.intervalSeconds`** (default 0 = target duration della playlist).

## [0.6.0] - 2026-08-17

Le prime regole che leggono più di un file: il master e le sue rendition insieme. 39 → 47 regole.

### Aggiunto

- **`src/core/crosscheck.ts`** (HL-7) e la categoria **`cross/*`**, otto regole per i difetti che *esistono solo fra le rendition* — ogni playlist, presa da sola, è valida:
  - `cross/version-mismatch`, `cross/target-duration-mismatch`: un player onora la versione della playlist che sta leggendo, e bufferizza sul target duration che trova.
  - `cross/segment-count-mismatch` ed `cross/timeline-drift`: conteggi diversi, oppure lo stesso conteggio con le boundary in punti diversi. Il secondo è il caso cattivo, perché non si vede da nessun file: chi cambia gradino riprende dalla boundary che conosce e finisce a metà immagine. Tolleranza di default 50ms, che lascia passare l'arrotondamento di un encoder (un frame a 25fps sono 40ms) e non mezzo secondo di offset vero.
  - `cross/discontinuity-mismatch`: un ad break un segmento più in là su un gradino rompe lo switch esattamente dove lo stream sta già cambiando.
  - `cross/playlist-type-mismatch`, `cross/media-sequence-mismatch`: un gradino con `EXT-X-ENDLIST` mentre gli altri sono live pianta ogni player che ci passa; finestre sfalsate fanno saltare avanti o indietro nel tempo chi cambia rendition.
  - `cross/bitrate-vs-declared` (HL-3): il `BANDWIDTH` del master contro l'`EXT-X-BITRATE` che la rendition dichiara di sé. Esce qui e non in `media/*` come diceva la voce originale, perché il confronto ha bisogno dei due file nello stesso posto.
- **Comando `HLS Lens: Check Renditions Together`**: carica ogni gradino giocabile del master aperto — da disco o dal CDN, secondo da dove viene il master — e scrive i finding in una **collection di diagnostics propria**, ancorati alla riga dell'`EXT-X-STREAM-INF` che nomina la rendition divergente. Una rendition irraggiungibile viene elencata nell'output channel e saltata: un gradino irraggiungibile non deve nascondere gli altri.

### Note di progetto

- **Si confrontano solo i gradini video giocabili.** Una rendition audio o di sottotitoli è legittimamente segmentata in modo diverso, e riportarlo come drift sarebbe un finding che non è un difetto.
- `docs/RULES.md` ha ora una quarta sezione, *Across playlists*, e `RuleDoc.scope` accetta `cross`.

## [0.5.0] - 2026-08-17

La specifica dentro l'editor: hover, completion e i quick fix per i finding che una modifica può chiudere da sola.

### Aggiunto

- **Hover sui tag** (HL-9): passando il cursore su un tag esce cosa fa, quale `EXT-X-VERSION` richiede, se è legale in un master o in una media playlist, e la tabella dei suoi attributi con i valori ammessi. La sorgente è **`src/core/spec.ts`**, la specifica come dato: ogni tag con scope, versione, sintesi e attributi. Un test verifica che il vocabolario e l'insieme dei tag noti al parser siano **lo stesso insieme nei due sensi** — un tag non può essere parsato senza essere documentato, né documentato senza essere parsato.
- **Completion** (HL-10): `completeAt` legge la riga fino al cursore e decide se lì ci va un nome di tag, un nome di attributo o un valore enumerato. Filtra i tag per tipo di playlist (a una media playlist non offre mai `EXT-X-STREAM-INF`) e non ripropone un attributo già presente sulla riga. Trigger su `#`, `:`, `,` e `=`.
- **Quick fix** (HL-11) per i tre finding meccanici: portare `EXT-X-VERSION` a quello che la playlist già usa, aggiungere l'`EXT-X-ENDLIST` mancante, alzare `EXT-X-TARGETDURATION` al segmento più lungo (arrotondato per eccesso, che è la condizione con cui la regola misura). **Solo quelli**: un `CODECS` mancante, un ladder mal distanziato o una chiave su HTTP richiedono una decisione che un comando dell'editor non deve prendere. Il fix della versione rilegge il numero dal messaggio del finding invece di ricalcolarlo, così non può contraddire la diagnostica che l'utente sta guardando.

### Corretto

- **`graphify-out/` finiva nel `.vsix`**: la directory è gitignorata, ma `vsce` pacchetta anche i file non tracciati, quindi un grafo costruito in locale (850 KB fra `graph.html` e `graph.json`) sarebbe stato spedito a ogni utente — il pacchetto era passato da 11 a 35 file. Ora è in `.vscodeignore`, con il motivo scritto accanto.
- **I quick fix non sarebbero mai comparsi**: il provider filtrava le diagnostiche su `source === 'HLS Lens'` mentre `updateDiagnostics` le marca `hls-lens`. Trovato prima di committare, confrontando la glue col punto in cui la source viene scritta.

## [0.4.0] - 2026-08-17

Sei regole nuove (33 → 39), tutte calcolabili dalle sole dichiarazioni del manifest. Scritte in TDD col RED verificato.

### Aggiunto

- **`master/codecs-resolution-mismatch`** (HL-1, warning): decodifica il livello H.264 dalla stringa `avc1`/`avc3` (`avc1.PPCCLL`, con il caso speciale del livello 1b) e lo confronta con `RESOLUTION` e `FRAME-RATE` usando i limiti di macroblocchi della tabella A-1 di ITU-T H.264. Un gradino che promette 1080p50 dichiarando Main@3.0 sta dicendo ai player che non sa decodificare quello che offre: i device severi — TV e set-top box, raramente il browser su cui si prova — lo rifiutano. Solo avc1/avc3: su HEVC, AV1 o una stringa che non si parsa la regola **non ha opinione**, perché un warning sbagliato su un gradino che funziona costa più di uno mancante. **Ha trovato due difetti veri nella fixture "clean" di questo repo** (720p50 su Main@3.1 e 1080p50 su High@4.0), corretti nello stesso commit.
- **`master/ladder-spacing`** (HL-2, hint): gradini a meno di 1.5× di distanza (ABR non li distingue: si paga due volte un encode e una entry di cache che nessuna decisione di switching può usare) e salti oltre 2.5× (quando la banda non regge il gradino sopra non c'è niente in mezzo su cui ripiegare).
- **`media/daterange`** (HL-4, warning): `EXT-X-DATERANGE` senza `START-DATE` utilizzabile, `DURATION` in disaccordo con `END-DATE`, due range della stessa `CLASS` che coprono gli stessi secondi, e un `SCTE35-IN`/`CUE-IN` che non chiude niente. Sono gli ad break: finiscono in una pubblicità che non parte, non finisce, o viene fatturata e mai mostrata.
- **`media/key-rotation`** (HL-5, hint) e **`media/key-dropped`** (HL-5, warning): una finestra live coperta da una sola chiave (solo con media sequence diversa da zero — la prima finestra non ha ancora niente da ruotare), e `METHOD=NONE` dopo segmenti cifrati, che lascia in chiaro tutto il resto della playlist. Due comportamenti, due id: hanno severità diverse e chi ne pinna uno non deve perdere l'altro.
- **`media/iframe-playlist-shape`** (HL-6, warning): una playlist `EXT-X-I-FRAMES-ONLY` i cui segmenti sono file interi invece di `EXT-X-BYTERANGE` — che fa scaricare un segmento per miniatura, cioè esattamente il costo che il trick play doveva evitare.

### Modificato

- **Fixture `master-clean.m3u8`**: i livelli `CODECS` dei gradini 720p50 e 1080p50 passano a `avc1.4d4028` (Main@4.0) e `avc1.64002a` (High@4.2), che è quello che un encoder produce davvero per quelle risoluzioni a 50fps. La fixture "pulita" non lo era.
- README, `docs/index.md` e `CLAUDE.md` aggiornati sul conteggio (5 structure, 14 master, 20 media).

### Non fatto, di proposito

- **HL-3 (`media/bitrate-vs-declared`)** resta aperta: il `BANDWIDTH` con cui confrontare gli `EXT-X-BITRATE` sta nel master, che un'analisi su singola playlist non vede mai. Esce con HL-7 (regole cross-playlist).
- La metà di HL-6 che voleva riconoscere una playlist che *dovrebbe* dichiarare `EXT-X-I-FRAMES-ONLY` non è decidibile da un file solo senza tirare a indovinare, e non è stata implementata.

## [0.3.3] - 2026-08-17

Il generatore dell'icona era l'ultimo pezzo di logica senza test: verificato a mano su quattro casi, che passano una volta sola e non lasciano niente dietro.

### Modificato

- **`src/core/png.ts`** (HL-20): `drawIcon` (il mark disegnato da primitive), `encodePng`/`decodePng` (8-bit RGBA, filtro 0, un IDAT) e `comparePixels` escono dallo script ed entrano nel core testato. `scripts/make-icon.ts` resta I/O — leggere un file, scriverne uno, scegliere un exit code — ed è bundlato come gli altri tool dalla mappa `TOOLS` di `esbuild.mjs`. **Il PNG committato è invariato byte per byte**: il refactor non tocca l'artefatto.
- **Test scritti prima, RED verificato**, e uno ha trovato un difetto vero: su un PNG troncato il decoder usciva con un `RangeError` di `Buffer` invece che con un errore che dice qual è il problema. Ora c'è una guardia sulla lunghezza del chunk. Gli altri coprono i pixel del mark (sfondo, i due verdi dei gradini, il rosso del difetto, l'angolo trasparente), il round-trip encode/decode, il rifiuto di un file non prodotto dal generatore e — il caso che ha fatto fallire la CI — due livelli di compressione della stessa immagine che devono risultare uguali.
- **La regola in `CLAUDE.md` diventa generale**: TDD con RED verificato per *qualunque* logica, generatori e tooling di build inclusi; se è logica sta in `src/core/` con un test, e lo script è glue. Solo la UI glue di `src/extension.ts` resta esente.

## [0.3.2] - 2026-08-17

Il primo push ha fatto girare la CI per davvero, e due gate si sono rotti nel modo in cui si rompono i gate: assumendo qualcosa che l'ambiente non garantisce.

### Corretto

- **Il gate dell'icona confronta i pixel, non i byte** (HL-18): `npm run icon:check` decodifica il PNG committato (IHDR, IDAT inflate, filtro 0 per scanline) e lo confronta con i pixel del generatore, al posto dello step che rigenerava il file e ne faceva il `git diff`. **La CI falliva su ogni run**: l'output DEFLATE non è fissato dal formato PNG, quindi lo zlib del runner Linux ricomprime la stessa immagine in byte diversi da quelli scritti su macOS, e il diff sui byte segnalava un'icona stantia su una macchina dove non era cambiato niente. Il gate resta severo su quello che deve cogliere — un pixel modificato a mano, una dimensione diversa, un file che non viene dal generatore — e lo dice indicando il primo pixel che diverge.
- **Il sync segnala le milestone lasciate indietro da una rinomina** (HL-19): `orphanMilestones` nel core (puro, testato) più il report nel job. Dopo la ristrutturazione delle sezioni ne erano rimaste **cinque** vuote sul tracker, ed erano invisibili. Segnala e non cancella mai: non può distinguere un residuo da una milestone aperta a mano. Il conteggio delle issue viene dall'endpoint `issues`, non dai contatori `open_issues`/`closed_issues` della milestone: **GitHub non li ricalcola** quando una issue cambia milestone, quindi la lista continuava a dichiarare piene proprio le milestone che questo sync aveva appena svuotato.

## [0.3.1] - 2026-08-17

### Modificato

- **Le sezioni di `BACKLOG.md` (cioè le milestone su GitHub) ora distinguono consegnato da pianificato**: una sezione consegnata prende il nome del tag che l'ha spedita (`v0.1.0 — Reading manifests`, `v0.2.0 — Backlog and roadmap automation`, `v0.3.0 — Publishing automation`, tutte chiuse), una pianificata prende il nome del tema (`Editor`, `Rules that pay for themselves`, …), e una voce si sposta dalla seconda alla prima quando esce. Il motivo è vincolante, non estetico: **una issue GitHub può avere una sola milestone**, quindi far coesistere "release" e "tema" nello stesso spazio di nomi significherebbe che il sync riassegna a ogni run ciò che si era messo a mano. Nessuna modifica al codice — gli id `HL-n` sono invariati e `docs/ROADMAP.md` è rigenerato.

## [0.3.0] - 2026-08-17

Pubblicazione automatica: un tag `v*` pushato è tutto il processo di release, store inclusi.

### Aggiunto

- **Job `publish` in `ci.yml`** (HL-15): su un tag `v*`, dopo che `release` ha pacchettizzato e allegato il `.vsix`, pubblica sul **VS Code Marketplace** (`vsce publish`) e su **Open VSX** (`ovsx publish --skip-duplicate`). Pubblica il **file esatto** allegato alla release invece di ripacchettizzare: quello che si installa dal Marketplace è byte per byte quello che sta sulla release. I PAT vivono nell'environment `marketplace`, che è anche il punto dove mettere un'approvazione manuale prima che un tag arrivi agli utenti.
- `ovsx` fra le devDependencies, pinnato: sia `vsce` che `ovsx` arrivano dal lockfile, perché un publish è l'unico job che non deve cambiare sotto i piedi (nessuna dipendenza **runtime**, come prima).

### Modificato

- **Un PAT mancante avvisa e salta, non fallisce**: senza `VSCE_PAT` il `.vsix` viene comunque costruito e allegato alla release, con un `::warning::` sulla run. Una X rossa su una build che ha prodotto un `.vsix` corretto si legge come "la release è rotta", quando la verità è "le credenziali dello store non ci sono ancora".
- **`scripts/backlog-sync.ts` verifica il repo prima di scrivere**: il 404 è un valore in tutto il resto dello script ("label non ancora creata", "milestone non ancora creata"), e questo rendeva un repo inesistente, un `GITHUB_REPOSITORY` sbagliato e un token senza accesso indistinguibili da un backlog vuoto — la run finiva con successo senza fare niente. Ora una richiesta iniziale su `/repos/:owner/:repo` trasforma quel silenzio in un errore con exit 1.

## [0.2.0] - 2026-08-17

Il piano di lavoro si mantiene da solo: `BACKLOG.md` è l'unica sorgente, roadmap e issue tracker sono proiezioni generate.

### Aggiunto

- **`src/core/backlog.ts`**: parser di `BACKLOG.md` nel core puro (milestone `##`, aree `###`, item `- [ ] **HL-n — Titolo**: descrizione`), più `renderRoadmap`, `backlogStats`, `progressBar` e la mappatura verso le issue (`markerOf`/`idFromBody`/`issueTitle`/`issueBody`). Test scritti prima dell'implementazione, incluso uno che parsa il `BACKLOG.md` **vero** del repo: un id duplicato o una voce malformata fa fallire `npm test`, non il job di sync.
- **`docs/ROADMAP.md` generato** (`npm run roadmap`): milestone con stato (shipped / in progress / planned), barra di avanzamento e voci raggruppate per area. Il rendering è **deterministico e senza data**, perché il gate in CI rigenera il file e ne fa il diff: un timestamp lo farebbe fallire a ogni run che non ha cambiato niente.
- **Workflow `backlog-sync`**: rende milestone e issue di GitHub un mirror di `BACKLOG.md` a ogni push che tocca il backlog (`workflow_dispatch` con input `dry_run` per vedere cosa farebbe). Idempotente: scrive solo ciò che diverge. Ogni issue è ancorata al suo id stabile da un marker nel body (`<!-- backlog:HL-7 -->`), così rinominare una voce ne cambia il titolo invece di aprirne una seconda; un id sparito dal file **non** viene chiuso in automatico, viene segnalato nel log (una chiusura implicita nasconderebbe lavoro cancellato per sbaglio).
- Script npm `roadmap` e `backlog:sync`, e in `esbuild.mjs` una tabella degli entry point dei tool (`--docs`, `--roadmap`, `--sync`) al posto del flag singolo.

### Modificato

- **`BACKLOG.md` ristrutturato** in milestone per release (`v0.1 — Foundation` … `Later — DASH`) con le checkbox: gli id `HL-n` sono invariati, la struttura ora è il formato che sync e roadmap leggono. **HL-17** chiuso da questa release.
- **`tsconfig.json` include `scripts/`**: i generatori erano fuori dal typecheck, cioè il codice che produce la documentazione era l'unico non controllato.
- **CI**: nuovo gate anti-divergenza su `docs/ROADMAP.md`, accanto a quelli di `docs/RULES.md` e dell'icona.

## [0.1.0] - 2026-08-17

Prima release: leggere un manifest HLS dentro VS Code, con il manifest che dice cosa ha di sbagliato.

### Aggiunto

- **Core puro** (`src/core/`, mai un import di `vscode`), con test su fixture locali:
  - **Parser m3u8** che tiene l'indice di riga (0-based, come `vscode.Position`) di ogni tag, URI, `EXTINF` e `PROGRAM-DATE-TIME`: senza quello un finding non può puntare alla riga da correggere, che è l'unico motivo per cui questa cosa è un'estensione e non un linter. Riconosce master, media e il caso misto; regge CRLF, BOM e tag malformati (un tag rotto diventa dato, mai un'eccezione).
  - **Parser delle attribute list** carattere per carattere: `CODECS="avc1.4d401f,mp4a.40.2"` è **un** valore con una virgola dentro, e splittare la riga sulle virgole è il modo in cui un manifest viene riportato come senza codec.
  - **33 regole** in tre categorie, ognuna con razionale che spiega il rischio: `syntax` (5), `master` (12), `media` (16). Fra le più utili: `syntax/version-too-low` con la tabella tag→versione minima di RFC 8216, `media/extinf-exceeds-target`, `media/pdt-drift` (confronta i passi di `PROGRAM-DATE-TIME` con la somma degli `EXTINF` — un difetto calcolabile dal solo manifest), `media/missing-map` per l'fMP4 senza init segment, `media/key-over-http`, `client`-side ladder: `master/undefined-group`, `master/duplicate-bandwidth`, `master/group-multiple-defaults`, e le regole LL-HLS `media/part-without-server-control` e `media/holdback-too-small`.
  - **Modello del ladder** (`buildLadder`, `renditionRows`, `ladderSummary`) con gli I-frame stream tenuti fuori dai gradini, dove devono stare.
  - **Risoluzione degli URI** relativa al manifest, sia per un master https su CDN sia per un file su disco.
  - **Bridge segcheck**: costruzione dell'argv e parsing del contratto JSON (`worst`, `summary`, `findings[]`), testati senza mai lanciare il binario.
  - **Fetcher** su `node:http(s)` con redirect, timeout e cap sul body. L'URL **finale** dopo i redirect è quello contro cui si risolvono gli URI figli: un redirect dimenticato manda l'albero e il deep check sull'host sbagliato.
- **Diagnostics mentre si scrive** (debounce 300ms), con `code` = id della regola, severità mappate sull'editor (`error`/`warning`/`hint`→Information, perché un Hint vero è visibile solo col cursore sulla riga) e filtri `hlsLens.diagnostics.minSeverity` / `.skip` per id o categoria.
- **Albero del manifest**: ladder in ordine di bitrate, renditions alternative, segmenti con durata e marche DISCONTINUITY/GAP/BYTERANGE (prima pagina di 50, perché una live ne ha migliaia), init segment e chiavi, e la lista dei problemi. Click su una riga = reveal della riga nel manifest.
- **`HLS Lens: Open Manifest URL…`**: fetch in un documento read-only (schema `hls-lens:`) con le diagnostics già sopra. L'URL di origine viaggia nella query dell'URI virtuale, così risolvere un figlio dopo un redirect non dipende da nessuno stato che possa diventare stantio.
- **Document link** su URI di variant, rendition, segmenti ed `EXT-X-MAP`: su disco aprono il file, su CDN aprono dove stanno.
- **`HLS Lens: Deep Check Segments (segcheck)`**: lancia `segcheck check --output json`, riporta i finding a livello di byte nello stesso pannello Problems (in una collection separata, così un'edit non li cancella) e in un Output channel, con progress cancellabile. Se il binario manca, un messaggio con il link alle istruzioni — tutto il resto dell'estensione funziona senza.
- **Status bar** con la riga di sintesi del manifest attivo, e **`HLS Lens: Show Rule Reference`** che apre il catalogo preso dal binario stesso.
- **Linguaggio `m3u8`**: grammatica TextMate (tag, attributi, stringhe, numeri, risoluzioni, URI) e `language-configuration.json`.
- **Icona generata** (`npm run icon`): `media/icon.png` disegnato da primitive con un encoder PNG scritto sopra `zlib` — il Marketplace vuole un PNG, e rasterizzare un SVG richiederebbe un browser o una libreria nativa in un'estensione che altrimenti ha zero dipendenze.
- **`docs/RULES.md` generato** dal catalogo compilato (`npm run docs`), con gate in CI che la rigenerazione sia un no-op: il riferimento non può descrivere regole che l'estensione non ha.

[0.7.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.7.0
[0.6.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.6.0
[0.5.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.5.0
[0.4.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.4.0
[0.3.3]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.3.3
[0.3.2]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.3.2
[0.3.1]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.3.1
[0.3.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.3.0
[0.2.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.2.0
[0.1.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.1.0
