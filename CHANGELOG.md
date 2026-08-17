# Changelog

Tutte le modifiche rilevanti a questa estensione sono documentate qui.
Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il progetto usa il [Semantic Versioning](https://semver.org/lang/it/).

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

[0.3.3]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.3.3
[0.3.2]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.3.2
[0.3.1]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.3.1
[0.3.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.3.0
[0.2.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.2.0
[0.1.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.1.0
