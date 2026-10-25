# Aeloria Launcher

Launcher Electron d'Aeloria (anciennement « GrandFantacube Launcher »).

- **Mods et versions du jeu** : lus à chaque lancement depuis le manifeste publié par
  [MMORPG_MOD](https://github.com/bananacheattv/MMORPG_MOD/releases/tag/latest) → un push sur le mod met à jour les joueurs.
- **Le launcher lui-même** : augmenter `version` dans `package.json` puis push sur `main` → la CI publie l'installeur,
  les launchers installés se mettent à jour tout seuls.
- Java (runtime Mojang), Minecraft, NeoForge et les ressources sont téléchargés automatiquement (`src/game.js`).
- Connexion Microsoft via `msmc`.

Dev : `npm install` puis `npm start`.

Tests : `npm test` (serveur HTTP local, interruptions, téléchargements concurrents, verrouillage Windows simulé et garde de lancement).

## Correctif Windows 1.3.1

Les téléchargements utilisent des fichiers temporaires uniques, attendent la fermeture du flux avant vérification/renommage et ne suppriment jamais le mod installé avant son remplacement. Les écritures vers un même fichier sont sérialisées. Les refus Windows transitoires sont réessayés ; un fichier durablement verrouillé affiche un message demandant de fermer Minecraft. Les autres téléchargements actifs se terminent avant de libérer une préparation échouée.

Une seule fenêtre de launcher est autorisée par session ; un second clic ne peut pas lancer une deuxième préparation ou modifier les mods pendant que le jeu lancé par cette fenêtre tourne.

Après une erreur `ENOENT`/`EPERM` sur un fichier `.jar.part`, fermer Minecraft et le launcher, puis installer la version 1.3.1. Conserver le dossier `.grandfantacube` : il contient les mondes, les réglages et la connexion du joueur. Les anciens fichiers `.part` ne sont pas réutilisés.
