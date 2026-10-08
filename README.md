# newpos

POS pentru restaurante cu **comandă de la masă prin QR**, adaptat pentru România, multi-locație.
Restaurant fictiv de test: **Smochinul de Aramă** (Cluj-Napoca + București).

> Interfața este intenționat minimală (funcțională, fără design) — urmează redesign.

## Pornire

```bash
npm install
npm start            # http://localhost:3000
npm test             # 22 teste (unitare + end-to-end cu Socket.IO)
```

PIN-uri de test: **manager 1234**, ospătari **1111 / 2222**, bucătărie **3333**.

1. Deschideți `http://localhost:3000` → alegeți locația → **POS** → PIN 1234.
2. **Coduri QR** (manager) → printați sau deschideți linkul „test” al unei mese pe telefon / în alt tab.
3. Clientul își scrie numele, adaugă produse, apasă **Trimite comanda**. Mai mulți clienți la aceeași masă = aceeași notă, cu produsele grupate pe persoană.
4. În POS comanda apare live (sunet + culoare pe plan) → **Confirmă** → bon de comandă la bucătărie/bar → **Încasează** (per client, pe produse sau tot) → **Închide masa**.
5. La final de zi: **Rapoarte X / Z**.

Pe telefoane din aceeași rețea folosiți adresa LAN afișată la pornire (sau setați `PUBLIC_URL`).

## Funcționalități

**Client (QR, fără aplicație / cont)**
- QR unic per masă, semnat (HMAC) — nu se poate ghici codul altei mese
- nume/poreclă per persoană, mai mulți clienți pe aceeași masă, coș personal cu mențiuni
- meniu cu gramaj, alergeni, etichete (vegetarian, picant…), produse epuizate ascunse live
- nota mesei în timp real, împărțită pe persoane, cu statusul comenzilor
- „Cheamă ospătarul”, „Cere nota”, „Șterge-mi numele” (GDPR)

**POS (ospătar / manager)**
- plan de sală văzut de sus (salon, terasă, bar, bucătărie), culori: liberă / ocupată / comandă nouă / cheamă / cere nota
- deschidere manuală masă, adăugare clienți, comenzi introduse de ospătar
- comenzi la **pachet** și **livrare** (nume, telefon, adresă)
- confirmare / respingere / servire comenzi; anulare produs cu motiv (după confirmare doar manager)
- reduceri pe produs sau pe masă (manager), mutare produs pe alt client, **mutare masă**, **unire mese**, alocare ospătar
- încasare per client, **pe produse** (split), sau integral; **plată mixtă**; rest automat doar din numerar; **bacșiș**
- metode: numerar lei, **numerar EUR la cursul BNR**, card, tichete de masă, voucher cadou, ordin de plată, pe cont client, protocol
- CIF client pe document cu **verificare ANAF** (denumire, adresă, plătitor TVA, inactiv)
- notă de plată (nefiscală), reprint, **stornare bon** (manager)
- intrări / ieșiri numerar (sold inițial, depuneri, plăți din casă)
- **Raport X** și **Raport Z**: numerotare consecutivă, Z cu valoare zero permis, avertizare la mese deschise,
  vânzări brute, reduceri, stornări, anulări, TVA pe cote (bază / TVA / total), încasări pe forme de plată,
  rest, bacșiș, sold numerar în sertar, EUR încasat, mese / clienți / medie per client, pe ospătari, pe categorii,
  top produse, pe ore, total cumulat; istoric Z
- raport vânzări pe orice perioadă, **export CSV** pentru contabilitate (separator `;`, UTF-8 BOM pentru Excel)
- meniu: disponibilitate și preț modificabile live (manager)
- personal cu PIN și roluri (manager / ospătar / bucătărie)
- **KDS** – ecran bucătărie și bar separat, cu timp de așteptare și buton „Gata”
- pagină **Stare**: sursa valorilor legale, starea casei de marcat / imprimantelor / bazei de date

## România: valori legale actualizate automat (`src/legal.js`)

| Ce | Sursă (API public) | Folosit pentru |
|---|---|---|
| Date firmă, plătitor TVA | **ANAF** – PlatitorTvaRest v9 (`webservicesp.anaf.ro`) | antet documente, verificare CIF client |
| Cote TVA | **Comisia Europeană TEDB** – VAT Retrieval Service | cota standard (A) și redusă pentru restaurante (B) |
| Curs EUR | **BNR** – `bnr.ro/nbrfxrates.xml` | plată în EUR, afișare echivalent |

Se verifică la pornire și la fiecare 6 ore; dacă un serviciu nu răspunde, rămân valorile din configurare
(`src/ro.js`) și eroarea apare în pagina **Stare**. Cotele implicite: **A 21%** (alcool, exceptând berea),
**B 11%** (mâncare, nealcoolice, bere — servicii de restaurant), D 0%. Verificați încadrarea cu contabilul.

**Casa de marcat (AMEF).** Legal, bonul fiscal și raportul Z fiscal se emit de casa de marcat conectată la ANAF;
aplicația nu le poate înlocui. Rapoartele X/Z din aplicație sunt rapoarte de gestiune care oglindesc structura
raportului Z și se trimit și către AMEF prin driver.

## Echipamente (`src/devices.js`)

Configurare per locație în `src/locations/<id>.js` → `devices`.

- casă de marcat: `simulated` (test), `file` (folder urmărit de programul producătorului — modul folosit de
  majoritatea caselor de marcat românești), `http` (bridge local). Formate: `json`, `text`; formatul exact al
  producătorului (Datecs, Tremol, Daisy etc.) se adaugă în `FORMATTERS`.
- imprimante bon comandă (bucătărie / bar): `escpos-tcp` (imprimantă de rețea, port 9100), `http`, `console`, `none`.
- orice dispozitiv cu browser poate fi terminal: PC, tabletă, telefon, ecran KDS.

## GDPR

- date minime: doar nume/poreclă la masă; telefon/adresă doar pentru livrare
- consimțământ informat la intrare + pagină `/confidentialitate` (model art. 13 — de completat cu datele operatorului)
- **anonimizare automată** după `RETENTION_DAYS` (implicit 30) de la închidere; clientul se poate șterge singur
- documentele fiscale nu conțin nume (doar ID-uri anonime și CIF firmă)
- Supabase găzduit în UE (Frankfurt), RLS activ fără politici publice — doar serverul are acces
- fără cookie-uri de urmărire; doar un ID tehnic în `localStorage`

## Multi-locație și scalare

- fiecare locație = un fișier în `src/locations/` (firmă/CUI, adresă punct de lucru, plan de sală, meniu/prețuri,
  echipamente); meniul se poate partaja între locații (`menu-smochinul.js`)
- numerotare separată per locație (bonuri, Z) — ca o casă de marcat per punct de lucru
- URL-uri per locație: `/l/<loc>/pos`, `/kds`, `/qr`, `/t/<masă>`
- un proces poate servi toate locațiile sau doar unele (`LOCATIONS=cluj`), cu aceeași bază de date —
  locațiile se pot împărți pe mai multe servere; toate tabelele au `location_id`
- vederea `daily_sales` în Supabase pentru rapoarte consolidate pe toate locațiile

## Supabase

Schema: `supabase/migrations/`. Setați `SUPABASE_URL` și `SUPABASE_SECRET_KEY` (cheia secretă / service_role,
**doar pe server**). Fără ele, datele se salvează în `data/<locatie>.json`.

## Structură

```
src/server.js          HTTP + Socket.IO, autentificare personal, evenimente client/POS/KDS
src/store.js           logica: mese, clienți, comenzi, plăți, stornări, numerar, X/Z, GDPR
src/supabase-sync.js   persistență Supabase (per locație)
src/legal.js           ANAF, TEDB (cote TVA), BNR, validare CIF
src/devices.js         drivere casă de marcat și imprimante
src/ro.js              cote TVA, metode de plată, tipuri de comenzi
src/locations/         configurația fiecărei locații
public/                pagini client, POS, KDS, QR (HTML + JS simplu, fără build)
test/                  teste node:test
```

## Ce nu este încă implementat

- protocolul nativ al fiecărui model de casă de marcat (se adaugă ca formatter în `devices.js`)
- e-Factura (SPV ANAF, necesită certificat digital / OAuth) pentru facturile B2B
- gestiune stocuri, rețetare, NIR, inventar, consum materii prime
- plată online din telefonul clientului (procesator de plăți), rezervări, program de fidelitate
- SAF-T (D406), integrare contabilitate (Saga, WinMentor etc.)
- interfață grafică finală
