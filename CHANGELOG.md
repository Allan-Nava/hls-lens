# Changelog

Tutte le modifiche rilevanti a questa estensione sono documentate qui.
Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e il progetto usa il [Semantic Versioning](https://semver.org/lang/it/).

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

[0.1.0]: https://github.com/Allan-Nava/hls-lens/releases/tag/v0.1.0
