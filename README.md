# Os do Punto · app del equipo

Web estática (GitHub Pages) + base de datos gratuita en Supabase.

## 1. Base de datos (Supabase, 5 minutos)
1. Crea una cuenta en https://supabase.com y un proyecto nuevo (región Europa).
2. Abre `supabase.sql`, cambia `CAMBIA-ESTA-CLAVE` (última línea) por tu contraseña de administrador.
3. En Supabase: **SQL Editor > New query**, pega todo el archivo y pulsa **Run**.
4. En **Project Settings > API** copia la **Project URL** y la clave **anon / publishable**.
5. Pégalas en `config.js` (`supabaseUrl` y `supabaseKey`). Esa clave es pública, no pasa nada por subirla a GitHub.

## 2. Publicar en GitHub Pages
1. Crea un repositorio y sube todos los archivos de esta carpeta.
2. **Settings > Pages > Source: Deploy from a branch > main / (root)**.
3. En un minuto la app estará en `https://TU-USUARIO.github.io/NOMBRE-REPO/`.
4. Opcional: sube el escudo como `logo.png` (cuadrado) y aparecerá en la cabecera y como icono.

## 3. Primer uso
1. Entra en la app, pulsa el engranaje, mete la contraseña y pulsa **Cargar plantilla y calendario de liga**.
2. La liga 2026/27 queda cargada con sus 22 jornadas (ida y vuelta). La Copa queda vacía hasta que se conozca.
3. Tras cada jornada: entra en el partido (Calendario) > **Poner resultado** > **Estadísticas de jugadores** > **Abrir votación**.
   Cuando hayan votado, **Cerrar votación** publica las notas y el MVP.

## Cómo funciona
- Cada jugador elige su nombre y crea su PIN la primera vez que vota o sube su foto. Si lo olvida, el administrador lo borra desde su ficha.
- Convocatoria: en cada partido los jugadores responden Voy / En duda / No puedo con su PIN.
- Amistosos: al añadir un partido elige "Amistoso" como competición; no cuentan para la clasificación.
- Cuotas (icono de cartera): el administrador crea cada cuota y apunta quién ha pagado; solo las ven los jugadores identificados con su PIN.
- La clasificación se calcula sola con los resultados que metas (los de todos los equipos).
- Sin `supabaseUrl`, la app arranca en modo demostración (datos solo en ese navegador, contraseña `admin`).
