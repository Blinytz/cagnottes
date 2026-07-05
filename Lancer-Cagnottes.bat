@echo off
title Cagnottes - serveur local (garder ouvert)
cd /d "%~dp0"
echo ================================================================
echo   Cagnottes demarre sur http://localhost:4321/
echo.
echo   - Firefox va s'ouvrir automatiquement sur l'application.
echo   - GARDE CETTE FENETRE OUVERTE pendant que tu utilises l'app.
echo   - Ferme-la (ou Ctrl+C) pour arreter le serveur.
echo ================================================================
echo.
start "" /min cmd /c "ping -n 2 127.0.0.1 >nul & start "" http://localhost:4321/"
python -m http.server 4321
