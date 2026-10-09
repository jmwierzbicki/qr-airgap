# QR Airgap

Przesyłanie dowolnego tekstu lub pliku między dwoma urządzeniami **wyłącznie przez ekran i kamerę**.
Nadajnik wyświetla strumień kodów QR, odbiornik filmuje go kamerą i składa plik, aż postęp dojdzie do 100%.
Żadna strona nie potrzebuje sieci, Bluetootha ani USB. Aplikacja to statyczna strona (Angular 21), po jednym
wejściu online działa też offline (PWA).

## Jak używać

1. **Odbiornik** (urządzenie odcięte od sieci): otwórz aplikację, zakładka *Odbierz*, *Start kamery*.
2. **Nadajnik**: zakładka *Nadaj*, wklej tekst albo wybierz plik, *Start*. Pomaga *Pełny ekran*.
3. Ustaw kamerę tak, żeby kod wypełniał kadr i był ostry. Kolejność ramek nie ma znaczenia; odbiór zaczyna się
   automatycznie i nie trzeba niczego powtarzać.
4. Po 100% odbiornik sprawdza sumę kontrolną i pokazuje przycisk *Pobierz plik* (dla tekstu także podgląd i *Kopiuj*).

Kamera wymaga bezpiecznego kontekstu: strona musi być serwowana przez **HTTPS** (GitHub Pages) albo z **localhost**.
Na urządzeniu offline wystarczy wcześniej otworzyć stronę raz (service worker zapisze ją w pamięci) albo
skopiować katalog `dist/qr-airgap/browser` i podać go lokalnym serwerem, np. `npx serve dist/qr-airgap/browser`.

## Parametry, strojenie na żywo i ranking

Parametry transmisji to suwaki na nadajniku: bajtów na kod (100–2000), klatek na sekundę (2–20), komórek na
klatkę (1, 2, 4) oraz przełączniki kodowania binarnego i koloru RGB. Nominalna przepustowość liczy się na
bieżąco. Kombinacje z tabeli nazw dostają etykietę "Przymiotnik Zwierzę" (np. *Żwawy Wilk* = 2 × 700 B,
10 kl/s, binarnie; *Barwny Bóbr* = 1 komórka × 3 kanały × 700 B, 10 kl/s), którą można też wpisać w pole
nazwy; pozostałe opisuje się parametrami.

Kanał jest jednokierunkowy, więc prędkość mierzy się po stronie odbiornika:

1. Odbiornik: *Start kamery*. Nadajnik: *Strojenie na żywo*. Nadajnik nadaje ramki testowe z bieżącymi
   parametrami (parametry jadą w nagłówku), a suwaki działają natychmiast, bez restartu.
2. Odbiornik obok wizjera pokazuje **teraz: X KB/s** (unikatowe kody w ruchomym oknie 3 s × bajtów na kod)
   z procentem nominału, a pod spodem **ranking** wszystkich wypróbowanych kombinacji, sortowany po
   najlepszym oknie, aktualizowany na bieżąco. Gdy przez kilka sekund nic nie dociera, pojawia się podpowiedź,
   że parametry są za gęste.
3. Zostaw suwaki na najlepszym ustawieniu (zapisuje się w przeglądarce) i wciśnij *Start* dla prawdziwego pliku.
   Nazwę z rankingu można też skopiować i wpisać na nadajniku.

Z włączonym kanałem dźwiękowym nadajnik pokazuje w strojeniu także tempo zgłaszane przez odbiornik, więc
całość da się zestroić, patrząc tylko na ekran nadawczy.

Pod *więcej* są jeszcze automatyczne przebiegi po tabeli (36 profili czarno-białych w 72 s, 24 kolorowe
w 48 s); ich wyniki trafiają do tego samego rankingu. Kalibruje się w trybie binarnym (odbiornik sam
przełącza się na ZXing).

## Kanał zwrotny przez dźwięk (opcjonalny)

Kanał ekran→kamera jest jednokierunkowy, więc po pierwszym cyklu nadajnik łata dziury "na ślepo" i przy
typowych 5–10% strat potrzebuje łącznie ok. 1,45–1,55 cyklu (symulacja na kodeku z aplikacji, K = 250).
Każdy ślepy rozkład, który łata szybciej, karze odbiornik dołączający po pierwszym cyklu, bo nie ma w nim
kropli stopnia 1. Z informacją zwrotną obie sytuacje da się obsłużyć naraz:

| odbiornik zgłasza | dosłanie przy 5% strat | przy 10% | łącznie |
|---|---|---|---|
| nic (dziś, na ślepo) | 113 kodów | 132 | 1,45–1,53 cyklu |
| liczbę brakujących bloków m | 22 | 48 | 1,09–1,19 cyklu |
| listę brakujących bloków | 15 | 28 | 1,06–1,11 cyklu |

Implementacja (`src/app/core/feedback.ts`, `src/app/audio/ggwave.ts`):

- **Raport** (odbiornik → nadajnik, co 2,5 s): id transferu, zdekodowane bloki, kodów odebranych w oknie,
  flaga "komplet", do 4 indeksów brakujących bloków. 15–31 bajtów.
- **Transport**: [ggwave](https://github.com/ggerganov/ggwave) (FSK + Reed-Solomon, 8–16 B/s) ładowany
  lokalnie z `ggwave/ggwave.js`. Protokół słyszalny albo ultradźwiękowy, do wyboru na odbiorniku. Odbiornik
  **tylko gra**, mikrofon włącza nadajnik, więc urządzenie odcięte od sieci niczego nie słucha.
- **Stopień kropli w numerze kropli**: górne 8 bitów numeru to spodziewana liczba braków m; odbiornik liczy
  wtedy sąsiadów o stopniu K/m, deterministycznie, bez wiedzy o kanale zwrotnym (format ramki v2).
- **Nadajnik** z nasłuchem: dosyła wprost bloki z listy brakujących na przemian z kroplami o stopniu K/m,
  zatrzymuje się po raporcie "komplet" (auto-stop), powtarza cykl systematyczny, gdy odbiornik zgłasza zero
  (dołączył późno), i opcjonalnie reguluje fps według stosunku odebranych kodów do nadanych.
- Bez raportów (hałas, brak mikrofonu) nadajnik zachowuje się jak dotąd.

Użycie: odbiornik → *Kanał zwrotny (dźwięk)* → *Włącz* (ew. *Test dźwięku*, żeby ustawić głośność);
nadajnik → *Kanał zwrotny (dźwięk)* → *Nasłuchuj odbiornika* (zgoda na mikrofon). Status pod przyciskiem
pokazuje ostatni raport. Weryfikacja bez sprzętu: pętla programowa (raport zakodowany ggwave wpuszczony w
strumień podstawiony pod mikrofon) dała poprawny odczyt listy braków i auto-stop.

## Multipleksowanie w kolorze: research i pomiar

Pomysł: trzy niezależne kody QR w kanałach R, G i B jednej klatki (3× danych w tym samym miejscu).
Literatura i istniejące projekty mówią, że to działa, ale z dwoma zastrzeżeniami, które decydują o wyniku
na konkretnym sprzęcie:

1. **Przenikanie kanałów** (crosstalk). Filtry Bayera w kamerze i prymarne barwy ekranu nachodzą na siebie
   widmowo, więc kanał G widzi część czerwieni itd. Wprost podane kanały R/G/B dekodują się źle; potrzebna
   jest normalizacja czernią i bielą oraz ewentualnie odwrócenie macierzy 3×3. libcimbar z tego powodu zszedł
   z 8 do 4 kolorów (2 bity na kafelek), JAB Code (ISO/IEC 23634) używa 4 lub 8 kolorów z paletą wzorcową w symbolu.
2. **Podpróbkowanie chrominancji**. Tor kamery w Androidzie (i większość kodeków wideo) oddaje obraz jako
   YCbCr 4:2:0: jedna próbka koloru na 4 piksele luminancji. Czarno-białe kody tego nie czują, kolorowe tak:
   moduł niosący dane w kolorze musi być ok. 2× większy niż moduł czarno-biały. Trzy kody w kolorze × 4× większe
   moduły to w najgorszym razie **mniej** danych niż jeden kod czarno-biały. Na szczęście nie każdy tor
   podpróbkowuje: `getUserMedia` na laptopie często daje pełny kolor, a telefon z kamerą 4K ma zapas.

Zamiast zgadywać, aplikacja ma **pomiar** (nadajnik: *Karta koloru*, odbiornik: *Pomiar koloru*):

- karta = czarno-biały kod QR jako kotwica geometryczna + pola K/R/G/B/C/M/Y/W + paski luminancji i
  chrominancji o szerokości 1–4 modułów (niebieski vs szary o tej samej luminancji);
- odbiornik z narożników kodu liczy homografię, próbkuje pola i raportuje: **marginesy separacji** R/G/B po
  normalizacji czernią i bielą (ile zostaje na próg; ≥ 0,35 dobrze, < 0,15 bez szans), **macierz przenikania**
  oraz **kontrast pasków** luminancji vs chrominancji dla każdej szerokości. Jeśli paski chrominancji gasną
  szybciej niż luminancji, tor podpróbkowuje kolor i wiadomo, o ile większe muszą być moduły;
- *Kopiuj wynik (JSON)* daje surowe liczby do dalszej analizy.

**Tryb kolorowy (eksperyment)** jest już w aplikacji: w każdej komórce trzy kody QR, po jednym w kanale R, G
i B (moduł ciemny w kodzie kanału gasi tylko ten kanał). Wzorce pozycjonujące są wspólne, więc zostają
czarno-białe. Odbiornik rozdziela klatkę na kanały i dekoduje każdy jako obraz w skali szarości; lokalna
binaryzacja ZXing radzi sobie z umiarkowanym przenikaniem bez jawnej korekcji macierzą. Ramki kolorowe mają
flagę w nagłówku, po której odbiornik w trybie *Automatycznie* przełącza się na dekodowanie kanałów (dekoder
czarno-biały widzi z kompozytu tylko kanał G, bo zieleń dominuje w luminancji). Czy to daje 3×, 1,5× czy nic,
rozstrzyga *Kalibracja koloru* i pomiar kartą na docelowym sprzęcie.

Źródła: [libcimbar ABOUT](https://github.com/sz3/cimbar/blob/master/ABOUT.md),
[JAB Code / ISO/IEC 23634](https://en.wikipedia.org/wiki/JAB_Code),
[Channel-wise barcodes for color display (Dinesh, Sharma)](https://hajim.rochester.edu/ece/sites/gsharma/papers/DineshChlwiseBarcodesColorDisplayJEI2019.pdf),
[Robust decoding of high-capacity color QR (HiQ)](https://arxiv.org/pdf/1704.06447),
[Colour multiplexing of QR codes (André 2014)](https://ietresearch.onlinelibrary.wiley.com/doi/full/10.1049/el.2014.2501),
[Android ImageFormat YUV_420_888](https://developer.android.com/reference/android/graphics/ImageFormat).

## Rozwój

```bash
npm install
npm start          # http://localhost:4200
npm test           # testy kodeka (vitest)
npm run build      # dist/qr-airgap/browser
```

Test end-to-end bez fizycznej kamery: w konsoli strony *Odbierz* podmień `navigator.mediaDevices.getUserMedia`
na funkcję zwracającą `canvas.captureStream()` z rysowanymi kodami. Tak zweryfikowano cały tor
QR → wideo → zxing-wasm → dekoder, łącznie z siatką 2 kodów, trybem binarnym i rankingiem kalibracji.

## Wdrożenie na GitHub Pages

Workflow `.github/workflows/deploy.yml` przy każdym pushu na `main`:
instaluje zależności, uruchamia testy, buduje z `--base-href` wyliczonym z nazwy repozytorium
(`/<repo>/`, a dla `<user>.github.io` po prostu `/`), dodaje `.nojekyll` i publikuje artefakt przez
`actions/deploy-pages`.

Jednorazowo w repozytorium: **Settings → Pages → Source: GitHub Actions**.

Routing używa `#/send` i `#/receive` (hash), więc odświeżenie strony nie daje 404 na Pages.
Jeśli projekt ma być podkatalogiem większego repozytorium, przenieś workflow do korzenia repo i dodaj
`defaults: run: working-directory: qr-airgap` oraz odpowiednie ścieżki w `cache-dependency-path` i `path`.

## Źródła

- txqr: https://github.com/divan/txqr
- Decimen (fountain codes + animowane QR, 2026): https://betterstack.com/community/guides/linux/decimen-optical/
- libcimbar: https://github.com/sz3/libcimbar
- Luby, "LT Codes" (FOCS 2002); rozkład robust soliton
- zxing-wasm: https://github.com/Sec-ant/zxing-wasm
- node-qrcode: https://github.com/soldair/node-qrcode
- Porównanie silników skanowania: https://strich.io/comparison-with-oss.html
