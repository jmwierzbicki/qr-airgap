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
- **Transport w QR**: ramka w base64, tryb bajtowy QR. Base64 kosztuje 25% pojemności, ale natywny `BarcodeDetector`
  zwraca wyłącznie tekst i przy surowych bajtach zgadywałby kodowanie znaków; ASCII jest bezpieczne w każdym silniku.
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

Przy 600 B i 8 kodach/s to ok. 4,7 KB/s nominalnie; w praktyce liczy się ile ramek kamera realnie dekoduje.
Odbiornik pokazuje na żywo klatki/s, kody/s i ETA, więc parametry da się dobrać empirycznie.

## Rozwój

```bash
npm install
npm start          # http://localhost:4200
npm test           # testy kodeka (vitest)
npm run build      # dist/qr-airgap/browser
```

Test end-to-end bez fizycznej kamery: w konsoli strony *Odbierz* podmień `navigator.mediaDevices.getUserMedia`
na funkcję zwracającą `canvas.captureStream()` z rysowanymi kodami (tak został zweryfikowany cały tor
QR → wideo → zxing-wasm → dekoder).

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
