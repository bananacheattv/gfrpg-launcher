# GrandFantacube Launcher

Launcher Electron du serveur GrandFantacube (mod Eldoria MMORPG).

- **Mods et versions du jeu** : lus à chaque lancement depuis le manifeste publié par
  [MMORPG_MOD](https://github.com/bananacheattv/MMORPG_MOD/releases/tag/latest) → un push sur le mod met à jour les joueurs.
- **Le launcher lui-même** : augmenter `version` dans `package.json` puis push sur `main` → la CI publie l'installeur,
  les launchers installés se mettent à jour tout seuls.
- Java (runtime Mojang), Minecraft, NeoForge et les ressources sont téléchargés automatiquement (`src/game.js`).
- Connexion Microsoft via `msmc`.

Dev : `npm install` puis `npm start`.
