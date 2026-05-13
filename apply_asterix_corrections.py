"""
One-off correction script for the 15 Asterix-Gesamtausgabe entries.
Pax researched the real Egmont hardcover collected-edition data; this applies it.
Idempotent: re-runs are safe (same data → same UPDATE, no side effect).
"""
from __future__ import annotations
import json, sqlite3, sys
from pathlib import Path

PKM = Path(__file__).resolve().parent
DB = PKM.parent / "PKM" / "mypka.db"
if not DB.exists():
    DB = PKM / "mypka.db"

ASTERIX = [
  {"node_id":"5OHLK-KDZ9Ki","band":1,"isbn":"978-3-7704-3713-9","year":2013,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343713/asterix_gesamtausgabe_-_band_01_-_gebundene_ausgabe.png",
   "contents":["Asterix der Gallier","Die goldene Sichel","Asterix und die Goten"],
   "desc":"Band 1 der Asterix-Gesamtausgabe von Egmont Ehapa: die drei ersten Klassiker der Serie in neu kolorierter, neu geletterter Fassung. Enthält 'Asterix der Gallier' (das Ur-Abenteuer mit dem Zaubertrank), 'Die goldene Sichel' und 'Asterix und die Goten'. Mit ausführlichen redaktionellen Vorworten von Horst Berner zu jeder Geschichte sowie illustrierten Sekundär-Artikeln und Skizzen."},
  {"node_id":"2hh--Og3q9fv","band":2,"isbn":"978-3-7704-3783-2","year":2014,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343783/asterix_gesamtausgabe_-_band_02_gebundene_ausgabe.png",
   "contents":["Asterix als Gladiator","Tour de France","Asterix und Kleopatra"],
   "desc":"Band 2 der Asterix-Gesamtausgabe versammelt drei der beliebtesten Reise-Abenteuer: 'Asterix als Gladiator' (Rettung des entführten Troubadix in Rom), 'Tour de France' (kulinarische Rundreise durch Gallien) und 'Asterix und Kleopatra' (Hilfe beim Palastbau für die Pharaonin). Sorgfältig neu koloriert, mit Hintergrund-Essays von Horst Berner."},
  {"node_id":"TuoSvF9I02nC","band":3,"isbn":"978-3-7704-3723-8","year":2014,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343723/asterix_gesamtausgabe_-_band_03_-_gebundene_ausgabe_1.png",
   "contents":["Der Kampf der Häuptlinge","Asterix bei den Briten","Asterix und die Normannen"],
   "desc":"Band 3 der Asterix-Gesamtausgabe enthält 'Der Kampf der Häuptlinge' (ein römertreuer Häuptling fordert Majestix heraus), 'Asterix bei den Briten' (Vetter Teefax und der gallische Zaubertrank in England) und 'Asterix und die Normannen' (die wikingerähnlichen Nordmänner wollen das Gruseln lernen). Mit erweiterten Vorworten und Sekundärmaterial."},
  {"node_id":"kkk1HBojmskY","band":4,"isbn":"978-3-7704-3724-5","year":2014,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343724/asterix_gesamtausgabe_-_band_04_-_gebundene_ausgabe.png",
   "contents":["Asterix als Legionär","Asterix und der Arvernerschild","Asterix bei den Olympischen Spielen"],
   "desc":"Band 4 der Asterix-Gesamtausgabe vereint drei Abenteuer rund um militärische und sportliche Herausforderungen: 'Asterix als Legionär' (Falbalas Verlobter Tragicomix wird gerettet), 'Asterix und der Arvernerschild' (Majestix erbt das Symbol Vercingetorix' und Cäsar will es) und 'Asterix bei den Olympischen Spielen' (Wettkampf in Olympia gegen Claudius Musculus). Neu koloriert, mit Vorworten von Horst Berner."},
  {"node_id":"6AnG_8qIYOlH","band":5,"isbn":"978-3-7704-3784-9","year":2015,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343784/asterix_gesamtausgabe_-_band_05_-_gebundene_ausgabe.png",
   "contents":["Asterix und der Kupferkessel","Asterix in Spanien","Streit um Asterix"],
   "desc":"Band 5 der Asterix-Gesamtausgabe enthält 'Asterix und der Kupferkessel' (ein verschwundener Schatz und unverdienter Verdacht), 'Asterix in Spanien' (die Befreiung des Goten-Geiselkindes Pepe) und 'Streit um Asterix' (der Römer Tullius Destructivus säht Zwietracht im Dorf). Mit umfangreichem Begleitmaterial."},
  {"node_id":"btPNMnQoOSAd","band":6,"isbn":"978-3-7704-3785-6","year":2014,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343785/asterix_gesamtausgabe_-_band_06_gebundene_ausgabe.png",
   "contents":["Asterix bei den Schweizern","Die Trabantenstadt","Die Lorbeeren des Cäsar"],
   "desc":"Band 6 der Asterix-Gesamtausgabe bringt drei Klassiker: 'Asterix bei den Schweizern' (Reise in die Alpen für seltene Edelweiße), 'Die Trabantenstadt' (Cäsar will eine römische Großsiedlung um das Dorf bauen) und 'Die Lorbeeren des Cäsar' (Asterix muss Cäsars Lorbeerkranz beschaffen). Sorgfältig neu koloriert mit modernisierter Comic-Schrift."},
  {"node_id":"JTUjGHtjP1wt","band":7,"isbn":"978-3-7704-3710-8","year":2013,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343710/asterix_gesamtausgabe_-_band_07_-_gebundene_ausgabe.png",
   "contents":["Der Seher","Asterix auf Korsika","Das Geschenk Cäsars"],
   "desc":"Band 7 der Asterix-Gesamtausgabe enthält 'Der Seher' (ein falscher Wahrsager nutzt den Aberglauben der Dorfbewohner), 'Asterix auf Korsika' (Befreiung eines korsischen Gefangenen und Besuch auf der Insel) und 'Das Geschenk Cäsars' (ein Legionär erhält das gallische Dorf als Ruhestandsgeschenk). Mit redaktionellen Vorworten und Begleitmaterial."},
  {"node_id":"eSgKQhWjw32U","band":8,"isbn":"978-3-7704-3786-3","year":2014,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343786/asterix_gesamtausgabe_-_band_08_gebundene_ausgabe.png",
   "contents":["Die große Überfahrt","Obelix GmbH & Co. KG","Asterix bei den Belgiern"],
   "desc":"Band 8 der Asterix-Gesamtausgabe vereint drei Goscinny-Klassiker: 'Die große Überfahrt' (versehentliche Entdeckung der Neuen Welt), 'Obelix GmbH & Co. KG' (Obelix als Hinkelstein-Industriemagnat) und 'Asterix bei den Belgiern' (das letzte Album, das Goscinny vor seinem Tod 1977 vollendete). Mit ausführlichem Vorwort zum Vermächtnis Goscinnys."},
  {"node_id":"SwIsBM75fayl","band":9,"isbn":"978-3-7704-3711-5","year":2013,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343711/asterix_gesamtausgabe_-_band_09_-_gebundene_ausgabe.png",
   "contents":["Der große Graben","Die Odyssee","Der Sohn des Asterix"],
   "desc":"Band 9 der Asterix-Gesamtausgabe enthält die ersten Uderzo-Solo-Abenteuer: 'Der große Graben' (ein durch rivalisierende Häuptlinge gespaltenes Dorf), 'Die Odyssee' (Reise in den Nahen Osten und Suche nach Steinöl-Ersatz) und 'Der Sohn des Asterix' (das mysteriöse Findelkind). Mit Kontext zur Übergangsphase nach Goscinnys Tod."},
  {"node_id":"mUp8I_aYmrZc","band":10,"isbn":"978-3-7704-3726-9","year":2014,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343726/asterix_gesamtausgabe_-_band_10_-_gebundene_ausgabe_1.png",
   "contents":["Asterix im Morgenland","Wie Obelix als kleines Kind in den Zaubertrank geplumpst ist"],
   "desc":"Band 10 der Asterix-Gesamtausgabe vereint 'Asterix im Morgenland' (Rettung einer indischen Prinzessin) mit der Origin-Story 'Wie Obelix als kleines Kind in den Zaubertrank geplumpst ist', die erklärt, woher Obelix' permanente Superkraft stammt. Zusätzlich enthalten: Skizzen und unveröffentlichtes Material von Uderzo."},
  {"node_id":"xkSMYYrKT3qK","band":11,"isbn":"978-3-7704-3900-3","year":2017,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343900/asterix_gesamtausgabe_-_band_11_1.png",
   "contents":["Asterix und Maestria","Obelix auf Kreuzfahrt","Asterix und Latraviata"],
   "desc":"Band 11 der Asterix-Gesamtausgabe enthält 'Asterix und Maestria' (eine Reporterin bringt das traditionelle Dorf in Aufruhr), 'Obelix auf Kreuzfahrt' (eine Zaubertrank-Panne führt nach Atlantis) und 'Asterix und Latraviata' (eine römische Agentin auf einem turbulenten Geburtstagsfest). Mit aktualisierten Vorworten von Horst Berner."},
  {"node_id":"jmf10yuvIDs8","band":12,"isbn":"978-3-7704-3887-7","year":2016,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343887/asterix_gesamtausgabe_-_band_12_-_gebundene_ausgabe.png",
   "contents":["Asterix plaudert aus der Schule","Gallien in Gefahr"],
   "desc":"Band 12 der Asterix-Gesamtausgabe enthält 'Asterix plaudert aus der Schule' (eine Sammlung von 14 Kurzgeschichten) und das letzte Solo-Album Uderzos 'Gallien in Gefahr' (eine außerirdische Bedrohung erschüttert das Dorf). Inklusive umfangreichem Skizzenteil zu 'Gallien in Gefahr'."},
  {"node_id":"qAeCHMkgVvlV","band":13,"isbn":"978-3-7704-3787-0","year":2014,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37343787/asterix_gesamtausgabe_-_band_13_1.png",
   "contents":["Asterix und Obelix feiern Geburtstag","Asterix bei den Pikten"],
   "desc":"Band 13 der Asterix-Gesamtausgabe vereint 'Asterix und Obelix feiern Geburtstag' (ein Jubiläumsband mit 56 Seiten Comic-Material und einer Galerie von rund 400 Asterix-Charakteren) sowie 'Asterix bei den Pikten' (das erste Album des neuen Teams Ferri/Conrad mit den unbeugsamen Galliern in Schottland). Inklusive Skizzen zu 'Asterix bei den Pikten'."},
  {"node_id":"dD8moanDvduC","band":14,"isbn":"978-3-7704-4025-2","year":2019,
   "cover":"https://www.egmont-shop.de/globalassets/01_egmont-catalog/37344025/asterix_gesamtausgabe_14_1.png",
   "contents":["Der Papyrus des Cäsar","Asterix in Italien","Asterix erobert Rom"],
   "desc":"Band 14 der Asterix-Gesamtausgabe enthält die beiden Ferri/Conrad-Alben 'Der Papyrus des Cäsar' (ein brisantes Dokument bedroht Cäsars Ruhm) und 'Asterix in Italien' (ein Wagenrennen quer durch Italien). Als Bonus zusätzlich das Filmalbum 'Asterix erobert Rom'. Mit ausführlichen Hintergrund-Essays zum Schaffen des neuen Autorenteams."},
  {"node_id":"GAXhU10xJi0-","band":15,"isbn":"978-3-7704-0349-3","year":2024,
   "cover":"https://www.egmont-shop.de/globalassets/04_produkte/produktbilder/comics/00_vorlaufige-cover/ecc_h2023/0349_ecc_vs_asterix_ga_15_c30.png",
   "contents":["Die Tochter des Vercingetorix","Asterix und der Greif","Die weiße Iris","Der Goldene Hinkelstein"],
   "desc":"Band 15 schließt die Kunstleder-Asterix-Gesamtausgabe ab und versammelt die drei jüngsten Ferri/Conrad-Alben: 'Die Tochter des Vercingetorix' (ein gallischer Teenager-Erbe mit Identitätskrise), 'Asterix und der Greif' (Reise zu den Sarmaten) und 'Die weiße Iris' (Konfrontation mit einer Wohlfühl-Psycho-Bewegung). Als Sonderbonus enthalten: 'Der Goldene Hinkelstein' (Originalstory in Bilderbuch-Form). Mit umfangreichem editorischem Anhang von Horst Berner als Abschluss der Reihe."},
]

def main():
    db = Path(r"C:\Users\cools\OneDrive - Familie Heiniger\Dokumente & Verträge - Documents\General\my-ai-team\PKM\mypka.db")
    conn = sqlite3.connect(db)
    c = conn.cursor()
    updated = 0
    for a in ASTERIX:
        c.execute("""
            UPDATE books SET
                isbn=?, publication_year=?, cover_image_url=?, description=?,
                description_source='pax-research',
                publisher='Egmont Ehapa Verlag',
                updated_at=datetime('now')
            WHERE node_id=?
        """, (a["isbn"], a["year"], a["cover"], a["desc"], a["node_id"]))
        updated += c.rowcount
    conn.commit()
    print(f"Updated {updated}/15 Asterix-Gesamtausgabe entries.")
    conn.close()

if __name__ == "__main__":
    main()
