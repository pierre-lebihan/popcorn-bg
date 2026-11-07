#!/usr/bin/env python3
"""Source lisible du référentiel BD & comics → data/bd_referentiel.json.

On édite ce fichier à la main (ou on demande à Claude de le compléter à partir d'articles),
puis : python scripts/build_bd_referentiel.py
Chaque citation pointe vers une source listée dans SOURCES (prix ou palmarès de critiques).
"""
import datetime, json, re, unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UPDATED_AT = "2026-11-07"

SOURCES = {
    "fauve": {"label": "Fauve d'or, meilleur album d'Angoulême", "short": "Fauve d'or", "points": 5,
              "url": "https://fr.wikipedia.org/wiki/Fauve_d'or_:_prix_du_meilleur_album"},
    "serie": {"label": "Prix de la série, Angoulême", "short": "Prix de la série Angoulême", "points": 4,
              "url": "https://en.wikipedia.org/wiki/Angoul%C3%AAme_International_Comics_Festival_Prize_for_a_Series"},
    "acbd": {"label": "Grand Prix de la critique ACBD", "short": "Grand Prix ACBD", "points": 4,
             "url": "https://www.acbd.fr/"},
    "eisner_serie": {"label": "Eisner, meilleure série", "short": "Eisner série", "points": 4,
                     "url": "https://en.wikipedia.org/wiki/Eisner_Award_for_Best_Continuing_Series"},
    "eisner_mini": {"label": "Eisner, meilleure mini-série", "short": "Eisner mini-série", "points": 3,
                    "url": "https://en.wikipedia.org/wiki/Eisner_Award_for_Best_Limited_Series"},
    "eisner_intl": {"label": "Eisner, meilleure BD étrangère publiée aux États-Unis", "short": "Eisner international", "points": 3,
                    "url": "https://en.wikipedia.org/wiki/Eisner_Award_for_Best_U.S._Edition_of_International_Material"},
    "moustique": {"label": "Moustique, les 100 meilleures BD (centenaire, 2024)", "short": "Top 100 Moustique", "points": 3,
                  "url": "https://comicsbeat.com/maus-tops-belgian-magazine-moustique-100-best-comics-list"},
    "classique": {"label": "Classique ajouté à la main (sans prix recensé)", "short": "Classique", "points": 1, "url": ""},
}

# (titre, type, mode, auteurs, année, tomes, citations, extras)
#   type : bd | comics
#   mode : series (à lire dans l'ordre, suivi « lu jusqu'au tome N »)
#          albums (albums indépendants, coche album par album)
#          oneshot (un seul livre)
#   citations : "source:année[:précision]"
T = [
    # ---- Fauve d'or (prix du meilleur album d'Angoulême)
    ("Corto Maltese", "bd", "series", "Hugo Pratt", 1967, 12, ["fauve:1976:La Ballade de la mer salée"]),
    ("Alack Sinner", "bd", "series", "José Muñoz, Carlos Sampayo", 1975, 8, ["fauve:1978", "fauve:1983:Flic ou privé"]),
    ("Paracuellos", "bd", "series", "Carlos Giménez", 1977, 6, ["fauve:1981"]),
    ("Silence", "bd", "oneshot", "Didier Comès", 1980, None, ["fauve:1981"]),
    ("Jonathan", "bd", "series", "Cosey", 1975, 17, ["fauve:1982:Kate"]),
    ("Les Cités obscures", "bd", "series", "François Schuiten, Benoît Peeters", 1983, 12,
     ["fauve:1985:La Fièvre d'Urbicande", "eisner_intl:2022:L'Ombre d'un homme"]),
    ("La Femme du magicien", "bd", "oneshot", "François Boucq, Jerome Charyn", 1986, None, ["fauve:1986"]),
    ("Torpedo", "bd", "series", "Jordi Bernet, Enrique Sánchez Abulí", 1982, 15, ["fauve:1986:Chaud devant !"]),
    ("Un été indien", "bd", "oneshot", "Milo Manara, Hugo Pratt", 1986, None, ["fauve:1987", "eisner_intl:2012"]),
    ("Maus", "comics", "series", "Art Spiegelman", 1986, 2, ["fauve:1988:tome 1", "fauve:1993:tome 2", "moustique:2024:n°1"]),
    ("Théodore Poussin", "bd", "series", "Frank Le Gall", 1987, 13, ["fauve:1989:Marie-Vérité"]),
    ("Watchmen", "comics", "oneshot", "Alan Moore, Dave Gibbons", 1987, None, ["fauve:1989", "eisner_mini:1988", "moustique:2024:n°19"]),
    ("V pour Vendetta", "comics", "oneshot", "Alan Moore, David Lloyd", 1989, None, ["fauve:1990", "moustique:2024:n°4"]),
    ("Le Chemin de l'Amérique", "bd", "oneshot", "Baru, Jean-Marc Thévenet", 1990, None, ["fauve:1991"]),
    ("Calvin et Hobbes", "comics", "series", "Bill Watterson", 1987, None, ["fauve:1992:Adieu, monde cruel !"]),
    ("Basil et Victoria", "bd", "series", "Édith, Yann", 1991, 6, ["fauve:1993:Jack"]),
    ("Trait de craie", "bd", "oneshot", "Miguelanxo Prado", 1993, None, ["fauve:1994"]),
    ("Le Cahier bleu", "bd", "oneshot", "André Juillard", 1994, None, ["fauve:1995"]),
    ("Jonas Fink", "bd", "series", "Vittorio Giardino", 1994, 3, ["fauve:1995:L'Enfance"]),
    ("L'Autoroute du soleil", "bd", "oneshot", "Baru", 1995, None, ["fauve:1996"]),
    ("Bone", "comics", "series", "Jeff Smith", 1991, 9, ["fauve:1996:La Forêt sans retour", "eisner_serie:1994", "eisner_serie:1995"]),
    ("Le Silence de Malka", "bd", "oneshot", "Ruben Pellejero, Jorge Zentner", 1996, None, ["fauve:1997"]),
    ("Léon la came", "bd", "series", "Nicolas de Crécy, Sylvain Chomet", 1995, 3, ["fauve:1998:Laid, pauvre et malade"]),
    ("Fax de Sarajevo", "comics", "oneshot", "Joe Kubert", 1996, None, ["fauve:1998"]),
    ("Monsieur Jean", "bd", "series", "Dupuy, Berberian", 1991, 7, ["fauve:1999:Vivons heureux sans en avoir l'air"]),
    ("Cages", "comics", "oneshot", "Dave McKean", 1998, None, ["fauve:1999"]),
    ("Ibicus", "bd", "series", "Pascal Rabaté", 1998, 4, ["fauve:2000:tome 2"]),
    ("Isaac le pirate", "bd", "series", "Christophe Blain", 2001, 5, ["fauve:2002:Les Amériques"]),
    ("Jimmy Corrigan", "comics", "oneshot", "Chris Ware", 2000, None, ["fauve:2003", "eisner_serie:1996:Acme Novelty Library", "eisner_serie:2000:Acme Novelty Library"]),
    ("Le Combat ordinaire", "bd", "series", "Manu Larcenet", 2003, 4, ["fauve:2004", "moustique:2024:n°44"]),
    ("Poulet aux prunes", "bd", "oneshot", "Marjane Satrapi", 2004, None, ["fauve:2005"]),
    ("Notes pour une histoire de guerre", "bd", "oneshot", "Gipi", 2004, None, ["fauve:2006"]),
    ("Là où vont nos pères", "bd", "oneshot", "Shaun Tan", 2006, None, ["fauve:2008", "moustique:2024:n°31"]),
    ("Pinocchio", "bd", "oneshot", "Winshluss", 2008, None, ["fauve:2009"]),
    ("Pascal Brutal", "bd", "series", "Riad Sattouf", 2006, 4, ["fauve:2010:Plus fort que les plus forts"]),
    ("Cinq mille kilomètres par seconde", "bd", "oneshot", "Manuele Fior", 2010, None, ["fauve:2011"]),
    ("Chroniques de Jérusalem", "bd", "oneshot", "Guy Delisle", 2011, None, ["fauve:2012"]),
    ("Quai d'Orsay", "bd", "series", "Christophe Blain, Abel Lanzac", 2010, 2, ["fauve:2013:tome 2"]),
    ("Come Prima", "bd", "oneshot", "Alfred", 2013, None, ["fauve:2014"]),
    ("L'Arabe du futur", "bd", "series", "Riad Sattouf", 2014, 6, ["fauve:2015"]),
    ("Ici", "comics", "oneshot", "Richard McGuire", 2014, None, ["fauve:2016", "moustique:2024:n°95"], {"hc": "Here McGuire"}),
    ("Paysage après la bataille", "bd", "oneshot", "Éric Lambé, Philippe de Pierpont", 2016, None, ["fauve:2017"]),
    ("La Saga de Grimr", "bd", "oneshot", "Jérémie Moreau", 2017, None, ["fauve:2018"]),
    ("Moi, ce que j'aime, c'est les monstres", "comics", "series", "Emil Ferris", 2017, 2, ["fauve:2019", "moustique:2024:n°10"],
     {"hc": "My Favorite Thing Is Monsters"}),
    ("Révolution", "bd", "series", "Florent Grouazel, Younn Locard", 2019, None, ["fauve:2020:Liberté"]),
    ("L'Accident de chasse", "comics", "oneshot", "Landis Blair, David L. Carlson", 2020, None, ["fauve:2021"],
     {"hc": "The Hunting Accident"}),
    ("Écoute, jolie Márcia", "bd", "oneshot", "Marcello Quintanilha", 2021, None, ["fauve:2022"]),
    ("La Couleur des choses", "bd", "oneshot", "Martin Panchaud", 2022, None, ["fauve:2023", "acbd:2023"]),
    ("Monica", "comics", "oneshot", "Daniel Clowes", 2023, None, ["fauve:2024"]),
    ("Deux filles nues", "bd", "oneshot", "Luz", 2024, None, ["fauve:2025"]),

    # ---- Prix de la série (Angoulême)
    ("Jérôme K. Jérôme Bloche", "bd", "series", "Alain Dodier", 1985, None, ["serie:2010"]),
    ("Il était une fois en France", "bd", "series", "Fabien Nury, Sylvain Vallée", 2007, 6, ["serie:2011"]),
    ("Cité 14", "bd", "series", "Pierre Gabus, Romuald Reutimann", 2007, None, ["serie:2012"]),
    ("Aâma", "bd", "series", "Frederik Peeters", 2011, 4, ["serie:2013"]),
    ("Lastman", "bd", "series", "Bastien Vivès, Balak, Michaël Sanlaville", 2013, 12, ["serie:2015"]),
    ("Miss Marvel", "comics", "series", "G. Willow Wilson, Adrian Alphona", 2014, None, ["serie:2016"], {"hc": "Ms. Marvel"}),
    ("Megg, Mogg & Owl", "comics", "series", "Simon Hanselmann", 2014, None, ["serie:2018"]),
    ("Dansker", "bd", "series", "Halfdan Pisket", 2014, 3, ["serie:2019"]),
    ("Paul", "bd", "series", "Michel Rabagliati", 1999, None, ["serie:2021:Paul à la maison"]),
    ("Spirou ou l'espoir malgré tout", "bd", "series", "Émile Bravo", 2018, 4, ["serie:2022", "moustique:2024:n°17"]),
    ("The Nice House on the Lake", "comics", "series", "James Tynion IV, Álvaro Martínez Bueno", 2021, None, ["serie:2024"]),

    # ---- Grand Prix de la critique ACBD
    ("Moi, assassin", "bd", "oneshot", "Antonio Altarriba, Keko", 2014, None, ["acbd:2015"], {"hc": "I, Assassin Altarriba"}),
    ("Préférence système", "bd", "oneshot", "Ugo Bienvenu", 2019, None, ["acbd:2020"]),
    ("Peau d'homme", "bd", "oneshot", "Hubert, Zanzim", 2020, None, ["acbd:2021"]),
    ("René.e aux bois dormants", "bd", "oneshot", "Elene Usdin", 2021, None, ["acbd:2022"]),
    ("Le Ciel dans la tête", "bd", "oneshot", "Antonio Altarriba, Sergio García Sánchez", 2023, None, ["acbd:2024"]),

    # ---- Eisner, meilleure série
    ("Concrete", "comics", "series", "Paul Chadwick", 1987, None, ["eisner_serie:1988", "eisner_serie:1989", "eisner_mini:1992:Fragile Creature"]),
    ("Sandman", "comics", "series", "Neil Gaiman", 1989, 10, ["eisner_serie:1991", "eisner_serie:1992", "eisner_serie:1993"], {"hc": "The Sandman"}),
    ("Astro City", "comics", "series", "Kurt Busiek, Brent Anderson", 1995, None, ["eisner_serie:1997", "eisner_serie:1998"]),
    ("Preacher", "comics", "series", "Garth Ennis, Steve Dillon", 1995, 9, ["eisner_serie:1999"]),
    ("Top 10", "comics", "series", "Alan Moore, Gene Ha, Zander Cannon", 1999, 2, ["eisner_serie:2001"]),
    ("100 Bullets", "comics", "series", "Brian Azzarello, Eduardo Risso", 1999, 13, ["eisner_serie:2002", "eisner_serie:2004"]),
    ("Daredevil (Bendis & Maleev)", "comics", "series", "Brian Michael Bendis, Alex Maleev", 2001, None, ["eisner_serie:2003"], {"hc": "Daredevil Bendis Maleev"}),
    ("The Goon", "comics", "series", "Eric Powell", 1999, None, ["eisner_serie:2005"]),
    ("Astonishing X-Men (Whedon)", "comics", "series", "Joss Whedon, John Cassaday", 2004, 4, ["eisner_serie:2006"], {"hc": "Astonishing X-Men Whedon"}),
    ("All-Star Superman", "comics", "series", "Grant Morrison, Frank Quitely", 2005, 2, ["eisner_serie:2007", "eisner_serie:2009"]),
    ("Y, le dernier homme", "comics", "series", "Brian K. Vaughan, Pia Guerra", 2002, 10, ["eisner_serie:2008"], {"hc": "Y: The Last Man"}),
    ("The Walking Dead", "comics", "series", "Robert Kirkman, Charlie Adlard", 2003, 32, ["eisner_serie:2010"]),
    ("Chew", "comics", "series", "John Layman, Rob Guillory", 2009, 12, ["eisner_serie:2011"]),
    ("Daredevil (Waid)", "comics", "series", "Mark Waid, Marcos Martín, Paolo Rivera", 2011, None, ["eisner_serie:2012"], {"hc": "Daredevil Mark Waid"}),
    ("Saga", "comics", "series", "Brian K. Vaughan, Fiona Staples", 2012, None, ["eisner_serie:2013", "eisner_serie:2014", "eisner_serie:2015", "eisner_serie:2017"]),
    ("Southern Bastards", "comics", "series", "Jason Aaron, Jason Latour", 2014, 4, ["eisner_serie:2016"]),
    ("Monstress", "comics", "series", "Marjorie Liu, Sana Takeda", 2015, None, ["eisner_serie:2018"]),
    ("Giant Days", "comics", "series", "John Allison, Max Sarin", 2015, None, ["eisner_serie:2019"]),
    ("Bitter Root", "comics", "series", "David F. Walker, Chuck Brown, Sanford Greene", 2018, None, ["eisner_serie:2020", "eisner_serie:2022"]),
    ("Usagi Yojimbo", "comics", "series", "Stan Sakai", 1987, None, ["eisner_serie:2021"]),
    ("Nightwing (Taylor & Redondo)", "comics", "series", "Tom Taylor, Bruno Redondo", 2021, None, ["eisner_serie:2023"], {"hc": "Nightwing Tom Taylor"}),
    ("Transformers (Daniel Warren Johnson)", "comics", "series", "Daniel Warren Johnson", 2023, None, ["eisner_serie:2024"], {"hc": "Transformers Daniel Warren Johnson"}),
    ("Santos Sisters", "comics", "series", "Greg & Fake, Graham Smith", 2023, None, ["eisner_serie:2025"]),
    ("Absolute Batman", "comics", "series", "Scott Snyder, Nick Dragotta", 2024, None, ["eisner_serie:2026"]),

    # ---- Eisner, meilleure mini-série
    ("Silver Surfer : Parabole", "comics", "oneshot", "Stan Lee, Moebius", 1988, None, ["eisner_mini:1989"], {"hc": "Silver Surfer Parable"}),
    ("Give Me Liberty", "comics", "oneshot", "Frank Miller, Dave Gibbons", 1990, None, ["eisner_mini:1991"]),
    ("Marvels", "comics", "oneshot", "Kurt Busiek, Alex Ross", 1994, None, ["eisner_mini:1994"]),
    ("Sin City", "comics", "series", "Frank Miller", 1991, 7, ["eisner_mini:1995:A Dame to Kill For", "eisner_mini:1996:The Big Fat Kill"]),
    ("Kingdom Come", "comics", "oneshot", "Mark Waid, Alex Ross", 1996, None, ["eisner_mini:1997"]),
    ("Batman : Un long Halloween", "comics", "oneshot", "Jeph Loeb, Tim Sale", 1996, None, ["eisner_mini:1998"], {"hc": "Batman: The Long Halloween"}),
    ("300", "comics", "oneshot", "Frank Miller, Lynn Varley", 1998, None, ["eisner_mini:1999"]),
    ("Hellboy", "comics", "series", "Mike Mignola", 1994, None, ["eisner_mini:2002:Conqueror Worm", "eisner_mini:2009:The Crooked Man"]),
    ("La Ligue des gentlemen extraordinaires", "comics", "series", "Alan Moore, Kevin O'Neill", 1999, None, ["eisner_mini:2003:vol. 2"], {"hc": "The League of Extraordinary Gentlemen"}),
    ("DC : The New Frontier", "comics", "oneshot", "Darwyn Cooke", 2004, None, ["eisner_mini:2005"], {"hc": "DC: The New Frontier"}),
    ("Seven Soldiers", "comics", "series", "Grant Morrison", 2005, None, ["eisner_mini:2006"]),
    ("Batman : Year 100", "comics", "oneshot", "Paul Pope", 2006, None, ["eisner_mini:2007"], {"hc": "Batman: Year 100"}),
    ("The Umbrella Academy", "comics", "series", "Gerard Way, Gabriel Bá", 2007, None, ["eisner_mini:2008"]),
    ("Daytripper", "comics", "oneshot", "Fábio Moon, Gabriel Bá", 2010, None, ["eisner_mini:2011"]),
    ("Criminal", "comics", "series", "Ed Brubaker, Sean Phillips", 2006, None, ["eisner_mini:2012:The Last of the Innocent"]),
    ("The Wake", "comics", "oneshot", "Scott Snyder, Sean Murphy", 2013, None, ["eisner_mini:2014"]),
    ("The Fade Out", "comics", "oneshot", "Ed Brubaker, Sean Phillips", 2014, None, ["eisner_mini:2016"]),
    ("Vision", "comics", "oneshot", "Tom King, Gabriel Hernández Walta", 2015, None, ["eisner_mini:2017"], {"hc": "The Vision Tom King"}),
    ("Mister Miracle", "comics", "oneshot", "Tom King, Mitch Gerads", 2017, None, ["eisner_mini:2019"], {"hc": "Mister Miracle Tom King"}),
    ("Little Bird", "comics", "oneshot", "Darcy Van Poelgeest, Ian Bertram", 2019, None, ["eisner_mini:2020"]),
    ("Superman's Pal Jimmy Olsen", "comics", "oneshot", "Matt Fraction, Steve Lieber", 2019, None, ["eisner_mini:2021"]),
    ("The Good Asian", "comics", "oneshot", "Pornsak Pichetshote, Alexandre Tefenkgi", 2021, None, ["eisner_mini:2022"]),
    ("Human Target", "comics", "oneshot", "Tom King, Greg Smallwood", 2021, None, ["eisner_mini:2023"], {"hc": "The Human Target Tom King"}),
    ("PeePee PooPoo", "comics", "oneshot", "Caroline Cash", 2023, None, ["eisner_mini:2024"]),
    ("Zatanna : Bring Down the House", "comics", "oneshot", "Mariko Tamaki, Javier Rodríguez", 2024, None, ["eisner_mini:2025"], {"hc": "Zatanna: Bring Down the House"}),
    ("Absolute Martian Manhunter", "comics", "oneshot", "Deniz Camp, Javier Rodríguez", 2025, None, ["eisner_mini:2026"]),

    # ---- Eisner, BD étrangère publiée aux États-Unis (hors mangas, déjà dans le classement AniList)
    ("Le Chat du rabbin", "bd", "series", "Joann Sfar", 2002, None, ["eisner_intl:2006"]),
    ("Le Photographe", "bd", "series", "Emmanuel Guibert, Didier Lefèvre, Frédéric Lemercier", 2003, 3, ["eisner_intl:2010"]),
    ("C'était la guerre des tranchées", "bd", "oneshot", "Jacques Tardi", 1993, None, ["eisner_intl:2011"]),
    ("Blacksad", "bd", "series", "Juan Díaz Canales, Juanjo Guarnido", 2000, 7,
     ["eisner_intl:2013:L'Enfer, le silence", "eisner_intl:2015:Amarillo", "eisner_intl:2023:Alors, tout tombe (1)", "eisner_intl:2024:Alors, tout tombe (2)"]),
    ("Putain de guerre !", "bd", "oneshot", "Jacques Tardi, Jean-Pierre Verney", 2008, None, ["eisner_intl:2014"]),
    ("Réaliste", "bd", "oneshot", "Asaf Hanuka", 2015, None, ["eisner_intl:2016"], {"hc": "The Realist Asaf Hanuka"}),
    ("Le Monde d'Edena", "bd", "series", "Moebius", 1983, 5, ["eisner_intl:2017"]),
    ("Cumbe", "bd", "oneshot", "Marcelo D'Salete", 2014, None, ["eisner_intl:2018"], {"hc": "Run for It D'Salete"}),
    ("Culottées", "bd", "series", "Pénélope Bagieu", 2016, 2, ["eisner_intl:2019"], {"hc": "Brazen Rebel Ladies"}),
    ("La Maison", "bd", "oneshot", "Paco Roca", 2015, None, ["eisner_intl:2020"], {"hc": "The House Paco Roca"}),
    ("Goblin Girl", "bd", "oneshot", "Moa Romanova", 2018, None, ["eisner_intl:2021"]),
    ("La Méduse", "bd", "oneshot", "Boum", 2022, None, ["eisner_intl:2025"], {"hc": "The Jellyfish Boum"}),
    ("Nocturnos", "bd", "oneshot", "Laura Pérez", 2023, None, ["eisner_intl:2026"]),
    ("Jason : Le Gang de la rive gauche", "bd", "oneshot", "Jason", 2005, None, ["eisner_intl:2007"], {"hc": "The Left Bank Gang"}),
    ("Jason : J'ai tué Adolf Hitler", "bd", "oneshot", "Jason", 2006, None, ["eisner_intl:2008"], {"hc": "I Killed Adolf Hitler"}),
    ("Jason : Le Dernier Mousquetaire", "bd", "oneshot", "Jason", 2008, None, ["eisner_intl:2009"], {"hc": "The Last Musketeer Jason"}),

    # ---- Top 100 Moustique (2024)
    ("Spirou et Fantasio (Franquin)", "bd", "albums", "André Franquin", 1946, None,
     ["moustique:2024:n°2 QRN sur Bretzelburg", "moustique:2024:n°21 Z comme Zorglub"], {"hc": "Spirou Franquin"}),
    ("Le Lierre et l'Araignée", "bd", "oneshot", "Grégoire Carlé", 2023, None, ["moustique:2024:n°3"]),
    ("L'Ascension du Haut Mal", "bd", "series", "David B.", 1996, 6, ["moustique:2024:n°5"], {"hc": "Epileptic David B."}),
    ("La Dernière Reine", "bd", "oneshot", "Jean-Marc Rochette", 2022, None, ["moustique:2024:n°6"]),
    ("Blast", "bd", "series", "Manu Larcenet", 2009, 4, ["moustique:2024:n°7"]),
    ("Building Stories", "comics", "oneshot", "Chris Ware", 2012, None, ["moustique:2024:n°9"]),
    ("Persepolis", "bd", "series", "Marjane Satrapi", 2000, 4, ["moustique:2024:n°24"]),
    ("Batman : Arkham Asylum", "comics", "oneshot", "Grant Morrison, Dave McKean", 1989, None, ["moustique:2024:n°34"], {"hc": "Arkham Asylum Morrison"}),
    ("Le Transperceneige", "bd", "series", "Jacques Lob, Jean-Marc Rochette", 1982, None, ["moustique:2024:n°49"], {"hc": "Snowpiercer"}),
    ("Ghost World", "comics", "oneshot", "Daniel Clowes", 1997, None, ["moustique:2024:n°52"]),
    ("Black Hole", "comics", "oneshot", "Charles Burns", 2005, None, ["moustique:2024:n°68"]),
    ("Palestine", "comics", "oneshot", "Joe Sacco", 1996, None, ["moustique:2024:n°74"]),
    ("The Spirit", "comics", "albums", "Will Eisner", 1940, None, ["moustique:2024:n°79"]),
    ("Peanuts", "comics", "albums", "Charles M. Schulz", 1950, None, ["moustique:2024:n°81"], {"hc": "The Complete Peanuts"}),
    ("Fun Home", "comics", "oneshot", "Alison Bechdel", 2006, None, ["moustique:2024:n°90"]),
    ("Mon ami Dahmer", "comics", "oneshot", "Derf Backderf", 2012, None, ["moustique:2024:n°92"], {"hc": "My Friend Dahmer"}),
]

TINTIN = ["Tintin au pays des Soviets", "Tintin au Congo", "Tintin en Amérique", "Les Cigares du pharaon", "Le Lotus bleu",
          "L'Oreille cassée", "L'Île Noire", "Le Sceptre d'Ottokar", "Le Crabe aux pinces d'or", "L'Étoile mystérieuse",
          "Le Secret de La Licorne", "Le Trésor de Rackham le Rouge", "Les Sept Boules de cristal", "Le Temple du Soleil",
          "Tintin au pays de l'or noir", "Objectif Lune", "On a marché sur la Lune", "L'Affaire Tournesol", "Coke en stock",
          "Tintin au Tibet", "Les Bijoux de la Castafiore", "Vol 714 pour Sydney", "Tintin et les Picaros", "Tintin et l'Alph-Art"]
ASTERIX = ["Astérix le Gaulois", "La Serpe d'or", "Astérix et les Goths", "Astérix gladiateur", "Le Tour de Gaule d'Astérix",
           "Astérix et Cléopâtre", "Le Combat des chefs", "Astérix chez les Bretons", "Astérix et les Normands",
           "Astérix légionnaire", "Le Bouclier arverne", "Astérix aux Jeux olympiques", "Astérix et le Chaudron",
           "Astérix en Hispanie", "La Zizanie", "Astérix chez les Helvètes", "Le Domaine des dieux", "Les Lauriers de César",
           "Le Devin", "Astérix en Corse", "Le Cadeau de César", "La Grande Traversée", "Obélix et Compagnie",
           "Astérix chez les Belges", "Le Grand Fossé", "L'Odyssée d'Astérix", "Le Fils d'Astérix", "Astérix chez Rahàzade",
           "La Rose et le Glaive", "La Galère d'Obélix", "Astérix et Latraviata", "Astérix et la Rentrée gauloise",
           "Le ciel lui tombe sur la tête", "L'Anniversaire d'Astérix et Obélix", "Astérix chez les Pictes",
           "Le Papyrus de César", "Astérix et la Transitalique", "La Fille de Vercingétorix", "Astérix et le Griffon",
           "L'Iris blanc", "Astérix en Lusitanie"]

T += [
    ("Tintin", "bd", "albums", "Hergé", 1930, len(TINTIN),
     ["moustique:2024:n°15 On a marché sur la Lune", "moustique:2024:n°25 Les Bijoux de la Castafiore"],
     {"albums": TINTIN, "hc": "Tintin Hergé"}),
    # ---- Classiques sans prix recensé ici (ajoutés à la main, 1 point) : Hardcover fait la différence
    ("Astérix", "bd", "albums", "René Goscinny, Albert Uderzo", 1961, len(ASTERIX), ["classique"], {"albums": ASTERIX, "hc": "Asterix Goscinny"}),
    ("Gaston", "bd", "albums", "André Franquin", 1960, 22, ["classique"], {"hc": "Gaston Lagaffe Franquin"}),
    ("XIII", "bd", "series", "Jean Van Hamme, William Vance", 1984, None, ["classique"], {"hc": "XIII Van Hamme"}),
    ("Thorgal", "bd", "series", "Jean Van Hamme, Grzegorz Rosiński", 1977, None, ["classique"], {"hc": "Thorgal"}),
    ("Blueberry", "bd", "series", "Jean-Michel Charlier, Jean Giraud", 1965, None, ["classique"], {"hc": "Blueberry Charlier Giraud"}),
    ("Largo Winch", "bd", "series", "Jean Van Hamme, Philippe Francq", 1990, None, ["classique"]),
    ("Les Passagers du vent", "bd", "series", "François Bourgeon", 1979, 9, ["classique"]),
    ("L'Incal", "bd", "series", "Alejandro Jodorowsky, Moebius", 1981, 6, ["classique"], {"hc": "The Incal"}),
    ("Valérian et Laureline", "bd", "series", "Pierre Christin, Jean-Claude Mézières", 1970, 23, ["classique"], {"hc": "Valerian Christin Mezieres"}),
    ("Les Vieux Fourneaux", "bd", "series", "Wilfrid Lupano, Paul Cauuet", 2014, None, ["classique"]),
]


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main() -> None:
    titles, seen = [], set()
    for row in T:
        title, kind, mode, authors, year, vols, cites = row[:7]
        extra = row[7] if len(row) > 7 else {}
        tid = slug(title)
        assert tid not in seen, tid
        seen.add(tid)
        cs = []
        for c in cites:
            parts = c.split(":", 2)
            assert parts[0] in SOURCES, c
            cs.append({"src": parts[0], "year": int(parts[1]) if len(parts) > 1 else None,
                       "note": parts[2] if len(parts) > 2 else ""})
        it = {"id": tid, "title": title, "kind": kind, "mode": mode, "authors": authors, "year": year,
              "volumes": vols, "cites": cs}
        it.update(extra)
        titles.append(it)
    out = {"updatedAt": UPDATED_AT, "sources": SOURCES, "titles": titles}
    p = ROOT / "data" / "bd_referentiel.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(titles)} titres → {p}")


if __name__ == "__main__":
    main()
