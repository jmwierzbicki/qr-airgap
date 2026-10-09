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

Parametry transmisji są zebrane w **profil**: bajtów na kod, klatek na sekundę, kodów na klatkę (1, 2 lub 4)
i kodowanie (base64 albo binarne). 72 kombinacje z tabeli kalibracyjnej mają czytelne nazwy
"Przymiotnik Zwierzę": zwierzę koduje siatkę i rozmiar bloku, przymiotnik koduje fps i kodowanie
(np. *Zwinny Wilk* = 2 kody × 700 B, 10 kl/s, binarnie).

Kanał jest jednokierunkowy, więc kalibracja działa "na ślepo":

1. Odbiornik: *Start kamery*. Nadajnik: *Kalibracja* (ok. 3 min). Nadajnik przelatuje po wszystkich
   profilach, każdy przez 2,5 s, nadając nieściśliwe ramki testowe.
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
