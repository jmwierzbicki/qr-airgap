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

## Profile i kalibracja

Parametry transmisji są zebrane w **profil**: bajtów na kod, klatek na sekundę, komórek na klatkę (1, 2 lub 4),
kolor (czarno-biały albo 3 kody RGB w komórce) i kodowanie (base64 albo binarne). 60 profili z tabeli
kalibracyjnej ma czytelne nazwy "Przymiotnik Zwierzę": zwierzę koduje siatkę i rozmiar bloku, przymiotnik
koduje fps i rodzaj (*Spokojny/Żwawy/Szybki* = czarno-biały 6/10/15 kl/s, *Tęczowy/Barwny/Jaskrawy* = RGB),
np. *Żwawy Wilk* = 2 kody × 700 B, 10 kl/s, a *Barwny Bóbr* = 1 komórka × 3 kanały × 700 B, 10 kl/s.

Kanał jest jednokierunkowy, więc kalibracja działa "na ślepo":

1. Odbiornik: *Start kamery*. Nadajnik: *Kalibracja* (36 profili czarno-białych, ok. 72 s) albo
   *Kalibracja koloru* (24 profile RGB, ok. 48 s). Nadajnik przelatuje po profilach od najłatwiejszych do
   najgęstszych, każdy przez 2 s, nadając nieściśliwe ramki testowe. Kalibruje się tylko w trybie binarnym
   (odbiornik sam przełącza się na ZXing); base64 to ta sama fizyka przy innej gęstości kodu.
   Gdy przez kilka sekund nic nie dociera, odbiornik podpowiada, że można przerwać.
2. Odbiornik zlicza, ile unikatowych kodów z każdego profilu dotarło, i na bieżąco pokazuje ranking
   wg realnej przepustowości (bajty odebrane / czas profilu). Najlepszy profil jest wyróżniony.
3. Na nadajniku wpisz nazwę zwycięskiego profilu w polu *Nazwa profilu* (wielkość liter i polskie znaki
   nie mają znaczenia) i wciśnij *Zastosuj*. Profil zapisuje się w przeglądarce.

Tryb binarny wymaga po stronie odbiornika silnika ZXing (BarcodeDetector zwraca tylko tekst). Odbiornik
rozpoznaje ramki binarne po sygnaturze `FQ` i sam przełącza silnik, jeśli trzeba.

## Dlaczego tak: research i wybór algorytmów

Kanał ekran → kamera jest **jednokierunkowy i stratny**. Nie ma kanału zwrotnego, więc odbiornik nie może poprosić
o powtórkę, a część ramek zawsze ginie (rozmycie ruchu, autofokus, niezgrany refresh ekranu i migawka kamery).
Porównane podejścia:

| Podejście | Przykłady | Ocena |
|---|---|---|
| Kolejne numerowane kawałki w pętli | `airgapped-qr-code-transfer`, większość prostych narzędzi | Każda zgubiona ramka to czekanie na pełny cykl. Przy K ramek i p% strat czas rośnie wykładniczo z K. |
| **Kod fontannowy (Luby Transform) + QR** | `txqr` (Go, 2018), `Decimen` (2026, ~129 KB/s wg autora) | Nieskończony strumień "kropli"; wystarczy odebrać ok. 1,05–1,15 K dowolnych ramek. Straty tylko wydłużają transfer. **Wybrane.** |
| Własny gęsty kod kolorowy | `libcimbar` (~106 KB/s) | Najszybsze, ale wymaga własnego dekodera i kalibracji kolorów; w przeglądarce dużo trudniejsze. |

### Warstwa kodowania

- **Kontener**: `[wersja][nazwa][MIME][dane]`, pakowany gzip (fflate) jeśli to się opłaca. Flaga w nagłówku ramki.
- **Fontanna LT** (`src/app/core/lt.ts`): rozkład *robust soliton* (c = 0,1, δ = 0,5), sąsiedzi kropli liczeni
  deterministycznie z ziarna PRNG (mulberry32), więc każda ramka jest samowystarczalna. Pierwsze K kropli jest
  **systematycznych** (kropla i = blok i): przy bezstratnym odbiorze pierwszy cykl daje 100%, a fontanna tylko łata
  dziury. Dekoder *peeling* (belief propagation) z kaskadowym rozwiązywaniem.
- **Ramka** (`src/app/core/frame.ts`): 26 B nagłówka (magic, id transferu, K, rozmiar bloku, długość, flagi, CRC32,
  numer kropli) + blok. Odbiornik może dołączyć w dowolnym momencie i sam wykrywa nowy transfer po zmianie id.
- **Transport w QR** (`src/app/core/wire.ts`): tryb bajtowy QR, ramka jako **base64** (działa z każdym
  skanerem, bo `BarcodeDetector` zwraca wyłącznie tekst) albo jako **surowe bajty** (+33% danych na kod,
  wymaga `zxing-wasm`, który oddaje bajty).
- **Siatka kodów**: 1, 2 lub 4 niezależne kody na klatce, każdy z własną kroplą. ZXing dekoduje wiele symboli
  z jednego obrazu, a kilka mniejszych kodów jest odporniejszych na perspektywę i nieostrość niż jeden wielki.
- **Integralność**: QR ma własną korekcję błędów (domyślnie L, bo fontanna i tak radzi sobie ze stratami, a L daje
  najwięcej danych na ramkę), a całość jest sprawdzana CRC32 przed rozpakowaniem.

### Warstwa skanowania

- **`BarcodeDetector`** (Chrome na Androidzie/macOS/ChromeOS, Safari 17+): sprzętowy, najszybszy, bez pobierania.
- **`zxing-wasm`** (ZXing-C++ w WebAssembly) w Web Workerze jako fallback (Chrome/Edge na Windows i Linuksie,
  Firefox). Plik `.wasm` jest serwowany lokalnie z `zxing/`, nie z CDN, więc działa offline. ZXing-C++ jest wyraźnie
  bardziej odporny na gęste kody (wersje 20–40) niż czysto JS-owe `jsQR`.
- Generowanie: `qrcode` (node-qrcode), stała wersja QR dla całego transferu i całkowita skala modułu, żeby kod był ostry.

### Parametry i orientacyjna przepustowość

| Bajtów na kod | Wersja QR (L) | Zastosowanie |
|---|---|---|
| 200–400 | ~10–15 | telefon z ręki, słabe światło |
| 600 (domyślnie) | ~20 | laptop + telefon, bezpieczny kompromis |
| 900–1300 | ~25–30 | monitor + nowoczesny telefon na statywie |
| 2000 | ~40 | tylko bardzo ostry obraz |

Przy 700 B i 10 klatkach/s to ok. 7 KB/s nominalnie na jeden kod, przy siatce 2×2 cztery razy tyle;
w praktyce liczy się, ile kodów kamera realnie dekoduje. Zamiast zgadywać, uruchom kalibrację (wyżej).
Odbiornik pokazuje też na żywo klatki/s, kody/s i ETA oraz pozwala wybrać rozdzielczość przechwytywania
(720p/1080p/4K).

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
