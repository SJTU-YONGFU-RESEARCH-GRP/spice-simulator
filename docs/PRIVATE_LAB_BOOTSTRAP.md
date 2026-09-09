# spice-simulator-lab (private) — bootstrap checklist

Use this checklist when creating / configuring
https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab

## 1. Create the private repo

- Visibility: **Private**
- Enable **Issues**
- Do **not** enable GitHub Pages on lab (public site lives on `spice-simulator`)

## 2. Labels

Create issue label:

- `icproj` — student / lab circuit shares from the editor

## 3. Submodule (public tree)

```bash
git clone git@github.com:SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab.git
cd spice-simulator-lab
git submodule add https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator.git spice-simulator
git commit -m "Add public spice-simulator submodule"
git push
```

`.gitmodules` should look like:

```ini
[submodule "spice-simulator"]
	path = spice-simulator
	url = https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator.git
```

## 4. Public repo hygiene

On https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator :

- Prefer **Issues disabled** (Settings → Features)
- Pages deploys from Actions using the obfuscated `release/` folder

## 5. Share flow

Students stay local-by-default. Optional **File → Share via GitHub Issue…** opens a new issue against **this private lab repo**, never the public open-source Issues list.
