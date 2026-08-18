# Changelog

Tutte le modifiche rilevanti a questa estensione sono documentate qui.
Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il progetto usa il [Semantic Versioning](https://semver.org/lang/it/).

## [0.17.0] - 2026-08-18

Il pannello Problems è dove un difetto si corregge, non dove lo si discute con chi ha prodotto il manifest.

### Aggiunto

- **`HLS Lens: Export Findings as a Report`** (`src/core/report.ts`): i finding come markdown da incollare in un ticket o come JSON per chi lo legge dopo — del manifest aperto, o dell'ultima scansione del workspace. Uno screenshot dell'editor è un pessimo allegato.
  - **Le righe sono 1-based nell'export.** Lo 0-based è la convenzione di un editor, ed è quella del core ovunque; un report lo leggono persone e CI, e contano entrambe da 1.
  - Il JSON porta un campo **`schema`**: chi lo parsa è codice scritto da qualcun altro e gli serve qualcosa a cui ancorarsi. I manifest puliti stanno nel sommario e non nell'elenco.
  - **Le pipe nei messaggi sono escapate**: un URI con dentro una `|` chiuderebbe la colonna in anticipo e sposterebbe ogni cella dopo di sé. C'è il test.
  - Nessun timestamp dentro il core, che deve restare deterministico per essere testabile: lo passa la glue.
- **Il vocabolario low latency nell'albero**: undici regole leggono `EXT-X-PART`, `EXT-X-PRELOAD-HINT` e `EXT-X-RENDITION-REPORT`, e l'albero non ne mostrava nessuno. Ora c'è una sezione con il server control (cioè: se quelle parti comprano latenza o no), le parti con durata e marche `INDEPENDENT`/`GAP`, l'hint su cui il player si blocca e i report con cui switcha rung. Tronca a 50 parti — una finestra live ne ha centinaia — e **lo dice** in una riga sua.

## [0.16.0] - 2026-08-18

Gli id delle regole sono l'API che un team fissa, e finora quell'API sapeva dire solo "spegnila".

### Aggiunto

- **`hlsLens.diagnostics.severity`**: rigrada una regola per id o un'intera categoria — `error`, `warning`, `hint` o `off`. Vince l'impostazione più specifica, quindi si può abbassare una categoria e tenere alta una regola dentro. Viene applicata **prima** del filtro `minSeverity`, così un hint promosso a errore resta visibile anche col pavimento alzato, e i finding vengono **ri-ordinati** dopo: una regola promossa a errore e lasciata in fondo al pannello sarebbe peggio che non promuoverla.
  - Un valore che non è una severità viene **lasciato stare**. È un refuso in un file di impostazioni: sia scartare la regola sia indovinare l'intenzione lo nasconderebbero.
- **Tre quick fix nuovi**, 4 → 7:
  - `syntax/unknown-tag`: propone il tag che si voleva scrivere, con la distanza di Levenshtein calcolata sul vocabolario del parser stesso. Il tetto è **due edit**: oltre non è un refuso ma un'estensione di vendor o un tag di una spec più nuova di questo parser, e riscriverla distruggerebbe una riga voluta. Il valore dopo i due punti è dell'autore e resta.
  - `master/rendition-default-not-autoselect`: `AUTOSELECT=NO` → `YES`.
  - `master/rendition-forced`: toglie `FORCED` **senza lasciare in giro la sua virgola** (c'è il test).

## [0.15.0] - 2026-08-18

DASH aveva le regole dalla `v0.8.0` e nessuna forma.

### Aggiunto

- **L'MPD come albero** (`src/core/mpdtree.ts`): periodi → adaptation set → representation, ognuno con la propria riga, il proprio indice di riga e i numeri che uno cerca davvero (bitrate, risoluzione, frame rate, lingua, se il set è allineato). La scala DASH *è* nel file, ma annidata quattro elementi in profondità e sparsa fra gli attributi: leggerla a occhio è esattamente il lavoro che questa estensione esiste per togliere. Cliccare una riga rivela la riga del file, e i Problems stanno in fondo come in una playlist.
- **`mpdSummary` nella status bar**: `static · 1 period · 2 adaptation sets · 5 representations · 10:30`. Un manifest dinamico non ha una durata totale da dichiarare, e infatti non ne dichiara una.
- `formatBandwidth` è quello di `ladder.ts`: un rung DASH e un rung HLS si leggono uguali.

### Corretto

- **Editare un `.mpd` non aggiornava niente fino al salvataggio**: `onDidChangeTextDocument` filtrava solo le playlist, quindi le diagnostics e l'albero di un MPD restavano fermi mentre lo si scriveva.

## [0.14.0] - 2026-08-18

Il manifest col difetto è quello che nessuno ha pensato di aprire.

### Aggiunto

- **`HLS Lens: Check All Manifests in Workspace`**: legge ogni `.m3u8`, `.m3u` e `.mpd` della cartella e riempie il pannello Problems, **file mai aperti inclusi**. Fino a ieri l'estensione si attivava su `workspaceContains` e poi aspettava che qualcuno cliccasse un file — cioè esattamente il file che uno ha già in mente, non quello rotto.
  - `src/core/workspace.ts` tiene la parte che è logica: cosa conta come manifest, il ranking (errori, poi warning, poi hint, poi **path**) e il report. L'ultimo criterio non è cosmetico: è ciò che rende due scansioni dello stesso albero confrontabili, quindi un report si può diffare con quello di ieri.
  - Quando il report tronca **dice quanti file ha lasciato fuori**, e quando la scansione si ferma al tetto dei 2000 manifest lo scrive nell'output. Un elenco troncato senza nota si legge come "questo è tutto", che è l'unico modo in cui un report può mentire.
  - I risultati stanno in una `DiagnosticCollection` loro. **Aprire un manifest cancella la copia della scansione**: le diagnostics vive sono autorevoli, e senza quella cancellazione ogni finding comparirebbe due volte.
  - Nuova impostazione `hlsLens.workspace.exclude` (default `**/node_modules/**`). La scansione rispetta `diagnostics.skip`, `diagnostics.minSeverity` e le due soglie, ed è annullabile.

### Corretto

- **Le milestone orfane su GitHub sono state cancellate** (dodici, lasciate indietro dalle rinomine delle sezioni). Il tracker ora è esattamente lo specchio del `BACKLOG.md` e il sync non segnala più niente.

## [0.13.0] - 2026-08-18

I gruppi di rendition: `EXT-X-MEDIA` letto da entrambi i lati. 73 → **81 regole**.

### Aggiunto

- **Otto regole `master/*` sui gruppi.** Un gruppo di rendition è l'unica parte di un master che un player risolve **per nome**, e quando il nome è sbagliato non fallisce niente ad alta voce: lo stream parte senza la traccia, e l'utente segnala "manca l'audio italiano" su un manifest che sembra a posto.
  - `master/rendition-missing-attributes` (error): `EXT-X-MEDIA` senza `TYPE`, `GROUP-ID` o `NAME`, o con un `TYPE` che la spec non definisce.
  - `master/rendition-uri` (error): subtitles senza `URI` — non c'è niente da scaricare — e il suo specchio, closed captions **con** un `URI` (la spec lo vieta: le caption viaggiano dentro il video) o senza `INSTREAM-ID`, che è ciò che dice quale servizio di caption sono.
  - `master/rendition-forced` (warning): `FORCED=YES` su qualcosa che non è subtitles. Lì non significa niente e i player lo ignorano, quindi di solito è una traccia che doveva essere altro.
  - `master/rendition-default-not-autoselect` (error): `DEFAULT=YES` con `AUTOSELECT=NO` — "questa a meno che non ti dicano altro" e "questa mai automaticamente" insieme. **`AUTOSELECT` assente non viene trattato come `NO`**: solo il "no" esplicito contraddice il default, ed è l'unico caso segnalato.
  - `master/rendition-duplicate-name` (warning): due voci identiche nel selettore tracce del player, e quale ti tocca dipende dall'ordine in cui le ha lette.
  - `master/audio-group-mixed-channels` (hint): un gruppo che mescola stereo e 5.1. Un player switcha dentro un gruppo liberamente, quindi cambiare lingua cambia il mix sotto lo spettatore.
  - `master/unused-group` (warning): lo specchio di `master/undefined-group` — un gruppo che nessuna variant nomina è codificato, pubblicato e cachato, e nessun player lo raggiunge. È la stessa rinomina vista dall'altro lato.
  - `master/inconsistent-groups` (warning): variant che non referenziano gli stessi gruppi. È quella che produce le segnalazioni più strane: un player sceglie il rung sulla banda, quindi avere l'audio alternativo diventa funzione della connessione in quel momento, e cambia a metà riproduzione. Sulla fixture `master-broken` se ne accendono due, sui gruppi `SUBTITLES` e `AUDIO`.
- **`Rendition.attrs`**: l'attribute list completa, per gli attributi che servono a una sola regola (`INSTREAM-ID`, `AUTOSELECT` esplicito).

### Modificato

- **Il separatore delle chiavi composte è ora `GROUP_KEY_SEPARATOR = '\u0000'`**, una costante con nome. Era già un NUL, ma scritto come **byte letterale** dentro il sorgente: invisibile in un diff, e `sed`/`awk` troncano la riga quando lo incontrano — mi è costato una ricerca a vuoto cercando un bug che non c'era.

## [0.12.0] - 2026-08-18

Il resto del vocabolario: i quattro tag che il parser conosceva e nessuna regola guardava. 67 → **73 regole**.

### Aggiunto

- **Le variabili vengono sostituite nel parser** (`Playlist.variables`, `defines`, `variableRefs`): un `{$name}` si risolve mentre si legge, quindi l'albero, i document link e tutte le regole vedono l'URI che verrà **davvero richiesto**. `IMPORT` e `QUERYPARAM` dichiarano il nome anche se il valore arriva dopo (dal master, o dalla query della richiesta), quindi il nome conta come dichiarato e il testo resta com'è.
- **`syntax/undefined-variable`** (error): un `{$name}` che nessun `EXT-X-DEFINE` dichiara. La sostituzione è testuale e **non ha un percorso d'errore**: il riferimento resta nell'URI graffe incluse e il player lo chiede così. Il 404 nomina un host con una `{` dentro, e quello è l'unico indizio — quindi il finding punta alla riga che lo usa, non al tag che avrebbe dovuto dichiararlo. Per lo stesso motivo l'URI **non** viene ripulito: sostituire un placeholder vuoto nasconderebbe il difetto.
- **`syntax/define-malformed`** (error): un `NAME` senza `VALUE` (non dichiara niente), due sorgenti per lo stesso valore, lo stesso nome definito due volte, e `IMPORT` in un master — `IMPORT` prende il valore dal master che ha referenziato la playlist, e un master non ne ha uno.
- **`master/session-data`** (error): `EXT-X-SESSION-DATA` senza `VALUE` né `URI` (nessun dato) o con entrambi (due risposte alla stessa domanda), e due voci che condividono `DATA-ID` e `LANGUAGE`. Lo stesso `DATA-ID` in due lingue è il senso di `LANGUAGE`, non un duplicato.
- **`master/content-steering`** (error): steering senza `SERVER-URI`, un secondo `EXT-X-CONTENT-STEERING`, e un `PATHWAY-ID` a cui nessuna variant appartiene — un player instradato su un pathway senza rendition dentro.
- **`media/start-offset`** (warning): `EXT-X-START` senza `TIME-OFFSET`, un offset fuori dalla playlist (il player torna al proprio default, quindi il tag non fa niente) e un offset negativo **dentro** le tre target duration che un player bufferizza prima di partire.
- **`cross/session-key-mismatch`** (warning): un `EXT-X-SESSION-KEY` il cui `METHOD`/`KEYFORMAT` nessuna rendition usa. Il tag esiste per far scaricare la chiave mentre il player legge ancora il master, invece di stallare sul primo segmento: pre-caricare quella sbagliata è lo stallo di prima più una richiesta.
- **`EXT-X-DEFINE` entra in `VERSION_REQUIREMENTS`** (versione 8).

### Modificato

- **`analyzeAcross` accetta un `master` opzionale.** La metà "session key" di HL-26 sembrava una regola `master/*` e non lo era: `EXT-X-SESSION-KEY` sta nel master e l'`EXT-X-KEY` che promette sta nelle rendition, quindi il confronto vuole entrambi i file. Tutte le altre regole cross confrontano rendition con rendition e il master non lo vedono.

## [0.11.1] - 2026-08-18

L'icona dice anche di cosa è fatta la scala.

### Modificato

- **Il mark ha un triangolo di play dentro la lente** (`media/icon.png`, `media/icon.svg`): senza quello i quattro rung sono barre di qualunque cosa — un grafico, un equalizzatore, un livello di batteria — e quello che la scala trasporta, e che un segmento rotto costa, è video. Il triangolo sta **dentro** l'anello della lente, dove non c'è nessun rung a passarci sotto, e si ferma prima dell'anello da entrambi i lati: la lente resta una lente e non diventa un pulsante play. Il difetto rosso sul rung più alto è dove era.
- **`drawIcon` ha una primitiva in più**, `fillTriangle` (test dei bordi, supersampling 4x per l'antialiasing come il resto del disegno). Come sempre prima il test sui pixel del mark — RED verificato sul pixel al centro della lente, che era ancora inchiostro — poi il disegno. Il PNG committato è rigenerato e il gate `npm run icon:check` lo confronta pixel per pixel.

## [0.11.0] - 2026-08-18

La timeline: la cosa che le regole potevano solo dire, disegnata.

### Aggiunto

- **`src/core/timeline.ts`** e il comando **`HLS Lens: Show Timeline`**: i segmenti come striscia, e su un master le rendition **impilate su un unico asse**. Su una media playlist disegna quella; su un master legge prima i rung (da disco o dal CDN, come `Check Renditions Together`).
  - `buildTimeline` mette i segmenti in fila e marca discontinuità, `EXT-X-GAP` e gli **ad break** dichiarati da un `EXT-X-DATERANGE`. Gli ad break li disegna **solo** se la playlist ha un `EXT-X-PROGRAM-DATE-TIME` che li ancora: un `DATERANGE` è agganciato al wall clock, e senza niente che leghi la timeline dei media a quell'orologio non c'è nulla da convertire. Un ad break indovinato in un'immagine è peggio di nessun ad break, perché un'immagine sembra un fatto.
  - Le **boundary che non tutti i rung condividono** diventano righe tratteggiate che attraversano tutte le tracce. Fuori passo si chiama la **minoranza** del cluster: con un rung su cinque che mette la boundary altrove è quel rung a essere sbagliato, e segnalarli tutti e cinque lo nasconderebbe. Prima scrivevo il contrario e un test su tre rendition l'ha bocciato.
  - `renderTimelineHtml` rende **tutta la pagina** come stringa, nel core. È il motivo per cui una webview finisce per avere dei test invece di uno screenshot: la glue crea il pannello, setta l'html e ritrasforma un click in una riga da rivelare. `niceTicks` sceglie il passo dell'asse fra valori tondi — un tick ogni 6,4 secondi è aritmeticamente corretto e illeggibile.
  - La pagina non carica **niente**: CSP `default-src 'none'`, `localResourceRoots: []`, nessun font, nessuno script esterno. Il nonce lo passa la glue, non il core: `renderTimelineHtml` deve restare deterministico per essere testabile.

### Corretto

- La nota di `0.9.1` diceva che la sezione tematica svuotata `## Rules that pay for themselves` restava nel `BACKLOG.md`: **non c'era già più**, l'avevo rimossa nello stesso commit sostituendola con `## Low latency`. Ora le sezioni tematiche svuotate si togliono, e le milestone che restano indietro le elenca il sync.

## [0.10.0] - 2026-08-18

Low latency. 58 → **67 regole**, e il parser che smette di limitarsi a contare le parti.

### Aggiunto

- **`Playlist.parts`**: le `EXT-X-PART` vengono tenute con `URI`, `DURATION`, `INDEPENDENT`, `GAP`, `BYTERANGE` e la **loro riga**, al posto del contatore `partCount`. Stanno per conto loro e non appese al `Segment`: una parte viene pubblicata *prima* del segmento che la contiene, e quel segmento potrebbe non essere mai scritto. Con loro il parser tiene anche `partInfLine`, `preloadHints` e `renditionReports`.
- **Nove regole `media/*` low latency.** Tutte leggono dichiarazioni, come il resto del catalogo: cosa contengano davvero quei byte resta una domanda per segcheck.
  - `media/part-without-part-inf` (error): parti senza `EXT-X-PART-INF`. Niente dice quanto dovrebbe durare una parte, e il player tira a indovinare a ogni fetch.
  - `media/part-exceeds-part-target` (error): una parte più lunga del `PART-TARGET` dichiarato. Il player dimensiona il reload bloccante su quel numero: una parte più lunga arriva dopo che si aspettava già la successiva — uno stallo esattamente al live edge, dove non c'è buffer che lo assorba. Il finding punta alla riga della parte.
  - `media/part-target-too-large` (warning): `PART-TARGET` pari o superiore al `TARGETDURATION`. La playlist paga tutto il costo della bassa latenza — più richieste, più tag, il reload bloccante — e non ne incassa niente.
  - `media/can-skip-until-too-small` (warning): `CAN-SKIP-UNTIL` sotto le sei target duration. È una soglia che nessun client conforme può chiedere, quindi i delta che il server si è preso la briga di supportare non li richiede nessuno.
  - `media/preload-hint` (error): hint senza `TYPE` o `URI`, e un secondo hint dello stesso tipo dove la spec ne ammette uno.
  - `media/preload-hint-not-preloading` (warning): un hint verso una parte che la playlist **già pubblica** (è una richiesta che il player avrebbe fatto comunque, non un preload) e un `TYPE=PART` in una playlist senza parti.
  - `media/rendition-report` (error): un report senza `URI` o senza `LAST-MSN` — non basta per switchare.
  - `media/rendition-report-out-of-step` (warning): un `LAST-MSN` a più di un segmento da dove sta questa playlist. O le rendition non vengono pubblicate in passo, o il report è stantio: in entrambi i casi chi switcha chiede un segmento che non c'è ancora, o ne ripete uno già visto.
  - `media/rendition-report-missing` (hint): una playlist low latency che non riporta nessuna altra rendition, e costringe chi switcha a scaricarne prima la playlist — il round trip che la bassa latenza esiste per togliere.
- **`test/fixtures/media-ll-broken.m3u8`**: una live low latency con cinque difetti, per la prova rapida senza Extension Host (`code test/fixtures/media-ll-broken.m3u8`).

### Corretto

- La nota di `0.9.1` diceva che nessuna regola guardava i tag LL-HLS: **era falsa**. `media/part-without-server-control` e `media/holdback-too-small` esistono da `v0.1.0` e coprono entrambi i pavimenti dell'hold-back e il `CAN-BLOCK-RELOAD` mancante. Di `HL-22` restava solo `CAN-SKIP-UNTIL`, ed è quello che è stato scritto.

## [0.9.1] - 2026-08-17

Nessun codice: la milestone successiva, aperta dove le milestone si aprono.

### Modificato

- **Nuova sezione `## Low latency` nel `BACKLOG.md`** — quindi una nuova milestone su GitHub e quattro issue (`HL-21`…`HL-24`), create dal sync e non a mano. Del vocabolario LL-HLS il parser legge tutto e `src/core/spec.ts` lo documenta tutto nell'hover, ma le regole ne coprono solo un angolo: `media/part-without-server-control` e `media/holdback-too-small` guardano `EXT-X-SERVER-CONTROL`, e **nessuna regola guarda una singola `EXT-X-PART`, un `EXT-X-PRELOAD-HINT` o un `EXT-X-RENDITION-REPORT`**. Il parser le parti le conta soltanto: una playlist può dichiarare parti più lunghe del proprio `PART-TARGET`, o senza `EXT-X-PART-INF`, e l'estensione tace.
- La sezione tematica `## Rules that pay for themselves`, svuotata quando le sue voci sono passate a `v0.4.0`, resta nel file ma **non esiste più per gli strumenti**: `parseBacklog` scarta le sezioni senza voci, quindi non è nel roadmap e il sync la elenca già fra le nove milestone orfane da cancellare a mano. Toglierla dal file non cambierebbe niente di quello che il sync vede.

## [0.9.0] - 2026-08-17

Il sito della documentazione, generato dagli stessi documenti che il repo tiene già — e ancora senza dipendenze.

### Aggiunto

- **`src/core/markdown.ts`**: il sottoinsieme di markdown che questi documenti usano davvero — heading (con áncora), paragrafi, liste, tabelle pipe di GitHub, code fence, code span, grassetto/corsivo, link — e nient'altro. Non è pigrizia: un'implementazione generale di markdown è una dipendenza, e questa estensione non ne ha per scelta. L'ambito è **verificato da un test** che renderizza ogni file di `docs/` e pretende che nessun heading si perda.
  - Tutto è escapato di default: le razionali delle regole sono piene di `<MPD>` e `#EXT-X-MAP:URI="…"`, e la lettura sicura di uno `<script>` in un esempio di manifest è il testo letterale.
  - I **code span vengono estratti prima** dell'emphasis, con sentinella `\u0000`: un asterisco dentro un id di regola non deve diventare corsivo, e un numero nella prosa ("4 gradini", "versione 7") non deve essere scambiato per un segnaposto. Entrambi i casi hanno un test.
- **`scripts/build-site.ts`** (`npm run site`) e il workflow **`pages.yml`**: `docs/` → `site/`, una pagina HTML autoconsistente per documento (CSS inline, nessuno script, nessun font da scaricare), pubblicata su GitHub Pages. Il titolo della pagina viene dal front matter o, per i documenti generati che non ce l'hanno, dal primo heading.
- **`site/` non si committa**: viene ricostruito a ogni deploy dai markdown, e due di quei documenti sono a loro volta generati e gated in CI — quindi una pagina non può descrivere uno stato in cui il codice non è. Il workflow lancia `npm test` prima di costruire: un renderer rotto non deve pubblicare.

## [0.8.0] - 2026-08-17

DASH. 47 → 58 regole, e ancora **zero dipendenze**: il lettore XML è scritto qui.

### Aggiunto

- **`src/core/xml.ts`**: lettore XML minimo — elementi, attributi, annidamento, indici di riga 0-based come tutto il resto del core. Non fa entity expansion oltre le cinque predefinite, né DTD, né risoluzione dei namespace: un MPD che ne ha bisogno viene **segnalato**, non indovinato. Non torna mai un'eccezione su un documento malformato, restituisce quello che è riuscito a leggere più gli errori — il chiamante è un linter, e "il file è rotto qui" è la cosa più utile che possa dire. Un `>` dentro un valore quotato non chiude il tag (c'è il test).
- **`src/core/dash.ts`**: `parseIsoDuration` (PT30S, PT1M30.5S, P1DT2H3M4S; anni e mesi deliberatamente no — non hanno una lunghezza fissa) e `analyzeMpd`, con **11 regole `dash/*`**:
  - `dash/timeline-gap`: gli `<S>` si concatenano, ognuno parte dove finisce il precedente se non lo dice con `@t`. Un `@t` che non torna è un buco nella presentazione — o due segmenti che rivendicano gli stessi secondi — ed è invisibile finché non sommi le durate.
  - `dash/duration-vs-timeline`: `@mediaPresentationDuration` contro quello che la timeline copre davvero.
  - `dash/dynamic-without-utctiming`: un client DASH live calcola quale segmento esiste dal **proprio** orologio più `@availabilityStartTime`. Senza `<UTCTiming>` un device con l'orologio indietro di qualche secondo chiede segmenti che non esistono ancora, e bufferizza per un motivo che nessun log del server spiega.
  - `dash/adaptationset-not-aligned`, `dash/missing-bandwidth`, `dash/missing-codecs`, `dash/segment-template-without-number` (un `@media` senza `$Number$` né `$Time$` risolve ogni segmento allo stesso URL), `dash/segment-template-without-init`, `dash/malformed-xml`, `dash/missing-presentation-duration`.
  - `dash/not-an-mpd`: un `.mpd` la cui radice non è `<MPD>` è quasi sempre una pagina d'errore salvata a mano. Dirlo una volta è più utile che riportare trenta attributi mancanti.
- **Linguaggio `dash-mpd`** (`.mpd`) e diagnostics sugli MPD nello stesso pannello Problems, con gli stessi filtri `minSeverity`/`skip`. Fixture `test/fixtures/dash-broken.mpd` testata regola per regola.

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

[0.17.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.17.0
[0.16.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.16.0
[0.15.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.15.0
[0.14.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.14.0
[0.13.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.13.0
[0.12.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.12.0
[0.11.1]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.11.1
[0.11.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.11.0
[0.10.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.10.0
[0.9.1]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.9.1
[0.9.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.9.0
[0.8.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.8.0
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
