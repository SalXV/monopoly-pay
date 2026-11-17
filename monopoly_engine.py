"""Motore di gioco autorevole (Server-Side) per Monopoly Pay & Real Estate."""

from __future__ import annotations

import copy
import datetime
import random
import string
import uuid
from typing import Any, Dict, List, Optional, Tuple

from classic_italian_deck import get_classic_italian_deck


VALID_TOKENS = {
    "cane",
    "cilindro",
    "auto",
    "nave",
    "ferro",
    "ditale",
    "carriola",
    "scarpa",
}


class RuleViolationError(Exception):
    """Errore sollevato quando un'azione viola le regole o i fondi sono insufficienti."""

    def __init__(self, message: str, code: str = "RULE_VIOLATION", extra: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.extra = extra or {}


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _uid(prefix: str = "id") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def generate_room_code() -> str:
    """Genera un codice stanza a 6 caratteri facile da leggere."""
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(chars) for _ in range(6))


def _normalize_property(raw: Dict[str, Any]) -> Dict[str, Any]:
    prop = copy.deepcopy(raw)
    prop.setdefault("ownerId", None)
    prop.setdefault("mortgaged", False)
    prop.setdefault("houses", 0)
    if "mortgageValue" not in prop:
        prop["mortgageValue"] = int(prop.get("price", 0)) // 2
    if "unmortgageCost" not in prop:
        prop["unmortgageCost"] = int(round(prop["mortgageValue"] * 1.1))
    return prop


def create_room_state(
    banker_name: str,
    banker_token: str,
    banker_color: str,
    currency: str = "€",
    starting_balance: int = 1500,
    free_parking_enabled: bool = False,
    custom_deck: Optional[List[Dict[str, Any]]] = None,
    code: Optional[str] = None,
) -> Tuple[Dict[str, Any], str]:
    """Crea una nuova stanza con il Banchiere come primo giocatore."""
    if not banker_name or not banker_name.strip():
        raise RuleViolationError("Inserisci il nome del Direttore di Banca.")
    if banker_token not in VALID_TOKENS:
        raise RuleViolationError("Pedina non valida.")
    if starting_balance < 0:
        raise RuleViolationError("Il saldo iniziale non può essere negativo.")

    room_code = (code or generate_room_code()).upper()
    banker_id = _uid("plr")

    deck_source = custom_deck if custom_deck else get_classic_italian_deck()
    properties = [_normalize_property(p) for p in deck_source]

    room: Dict[str, Any] = {
        "code": room_code,
        "createdAt": _now_iso(),
        "currency": currency.strip() or "€",
        "startingBalance": int(starting_balance),
        "freeParkingEnabled": bool(free_parking_enabled),
        "freeParkingPot": 0,
        "bankerId": banker_id,
        "version": 1,
        "players": {
            banker_id: {
                "id": banker_id,
                "name": banker_name.strip(),
                "token": banker_token,
                "color": banker_color or "#0A84FF",
                "balance": int(starting_balance),
                "isBanker": True,
                "isBankrupt": False,
                "joinedAt": _now_iso(),
            }
        },
        "properties": properties,
        "pendingRequests": [],
        "auditLog": [
            {
                "id": _uid("log"),
                "timestamp": _now_iso(),
                "type": "ROOM_CREATED",
                "fromId": "BANK",
                "fromName": "BANCA",
                "toId": banker_id,
                "toName": banker_name.strip(),
                "amount": int(starting_balance),
                "reason": f"Partita creata (Saldo iniziale {starting_balance} {currency.strip() or '€'})",
                "isBankAction": True,
                "globalBanner": f"🏦 Stanza {room_code} avviata! Banchiere: {banker_name.strip()}",
            }
        ],
    }
    return room, banker_id


def join_room(room: Dict[str, Any], name: str, token: str, color: str) -> str:
    """Aggiunge un giocatore alla stanza."""
    clean_name = (name or "").strip()
    if not clean_name:
        raise RuleViolationError("Inserisci il tuo nome.")
    if token not in VALID_TOKENS:
        raise RuleViolationError("Pedina non valida.")

    for p in room["players"].values():
        if p["name"].lower() == clean_name.lower():
            raise RuleViolationError("Esiste già un giocatore con questo nome nella stanza.")
        if p["token"] == token:
            raise RuleViolationError("Questa pedina è già stata scelta da un altro giocatore.")

    player_id = _uid("plr")
    starting_balance = int(room["startingBalance"])
    room["players"][player_id] = {
        "id": player_id,
        "name": clean_name,
        "token": token,
        "color": color or "#30D158",
        "balance": starting_balance,
        "isBanker": False,
        "isBankrupt": False,
        "joinedAt": _now_iso(),
    }
    _append_log(
        room,
        tx_type="PLAYER_JOINED",
        from_id="BANK",
        from_name="BANCA",
        to_id=player_id,
        to_name=clean_name,
        amount=starting_balance,
        reason="Ingresso in partita con capitale iniziale",
        is_bank_action=True,
        global_banner=f"👋 {clean_name} si è unito alla partita ({starting_balance}{room['currency']})",
    )
    return player_id


def update_deck(room: Dict[str, Any], actor_id: str, new_deck: List[Dict[str, Any]]) -> None:
    """Permette al Banchiere di aggiornare il mazzo contratti (solo proprietà non ancora possedute o reset)."""
    _require_banker(room, actor_id)
    if not isinstance(new_deck, list) or len(new_deck) == 0:
        raise RuleViolationError("Il mazzo contratti non può essere vuoto.")

    existing_by_id = {p["id"]: p for p in room["properties"]}
    updated: List[Dict[str, Any]] = []
    seen_ids = set()
    for raw in new_deck:
        prop_id = str(raw.get("id") or _uid("prop")).strip()
        if prop_id in seen_ids:
            raise RuleViolationError(f"ID proprietà duplicato: {prop_id}")
        seen_ids.add(prop_id)
        norm = _normalize_property(raw)
        norm["id"] = prop_id
        # Preserva stato proprietà se già esistente
        if prop_id in existing_by_id:
            old = existing_by_id[prop_id]
            norm["ownerId"] = old["ownerId"]
            norm["mortgaged"] = old["mortgaged"]
            norm["houses"] = old["houses"]
        updated.append(norm)

    room["properties"] = updated
    _append_log(
        room,
        tx_type="DECK_UPDATED",
        from_id="BANK",
        from_name="BANCA",
        to_id="ALL",
        to_name="Tavolo",
        amount=0,
        reason=f"Mazzo contratti aggiornato ({len(updated)} carte)",
        is_bank_action=True,
        global_banner=f"🃏 LA BANCA ha aggiornato il Mazzo Contratti ({len(updated)} carte)",
    )


def update_room_settings(room: Dict[str, Any], actor_id: str, free_parking_enabled: Optional[bool] = None) -> None:
    _require_banker(room, actor_id)
    if free_parking_enabled is not None:
        room["freeParkingEnabled"] = bool(free_parking_enabled)
        status_label = "ATTIVO" if room["freeParkingEnabled"] else "DISATTIVO"
        _append_log(
            room,
            tx_type="SETTINGS_UPDATED",
            from_id="BANK",
            from_name="BANCA",
            to_id="ALL",
            to_name="Tavolo",
            amount=0,
            reason=f"Salvadanaio Parcheggio Gratuito: {status_label}",
            is_bank_action=True,
            global_banner=f"🅿️ Parcheggio Gratuito impostato su {status_label}",
        )


def _require_banker(room: Dict[str, Any], actor_id: str) -> None:
    if actor_id != room["bankerId"]:
        raise RuleViolationError("Solo il Direttore di Banca può eseguire questa operazione.", code="FORBIDDEN")


def _get_player(room: Dict[str, Any], player_id: str) -> Dict[str, Any]:
    player = room["players"].get(player_id)
    if not player:
        raise RuleViolationError("Giocatore non trovato.", code="NOT_FOUND")
    return player


def _get_property(room: Dict[str, Any], prop_id: str) -> Dict[str, Any]:
    for prop in room["properties"]:
        if prop["id"] == prop_id:
            return prop
    raise RuleViolationError("Proprietà non trovata.", code="NOT_FOUND")


def _get_group_properties(room: Dict[str, Any], color_group: str) -> List[Dict[str, Any]]:
    return [p for p in room["properties"] if p.get("colorGroup") == color_group]


def _owns_full_group(room: Dict[str, Any], player_id: str, color_group: str) -> bool:
    group = _get_group_properties(room, color_group)
    return len(group) > 0 and all(p.get("ownerId") == player_id for p in group)


def _group_has_any_mortgage(room: Dict[str, Any], color_group: str) -> bool:
    return any(p.get("mortgaged") for p in _get_group_properties(room, color_group))


def _group_has_any_houses(room: Dict[str, Any], color_group: str) -> bool:
    return any(int(p.get("houses", 0)) > 0 for p in _get_group_properties(room, color_group))


def _ensure_sufficient_funds(room: Dict[str, Any], player_id: str, amount: int, creditor_id: str = "BANK") -> None:
    player = _get_player(room, player_id)
    if player["isBankrupt"]:
        raise RuleViolationError(f"{player['name']} è in bancarotta.")
    if int(player["balance"]) < int(amount):
        suggestions = get_debt_suggestions(room, player_id, int(amount))
        raise RuleViolationError(
            f"Fondi insufficienti per {player['name']}: servono {amount}{room['currency']}, disponibili {player['balance']}{room['currency']}.",
            code="INSUFFICIENT_FUNDS",
            extra={
                "playerId": player_id,
                "requiredAmount": int(amount),
                "currentBalance": int(player["balance"]),
                "deficit": int(amount) - int(player["balance"]),
                "creditorId": creditor_id,
                "suggestions": suggestions,
            },
        )


def _append_log(
    room: Dict[str, Any],
    tx_type: str,
    from_id: str,
    from_name: str,
    to_id: str,
    to_name: str,
    amount: int,
    reason: str,
    is_bank_action: bool = False,
    global_banner: Optional[str] = None,
    property_id: Optional[str] = None,
    property_name: Optional[str] = None,
) -> Dict[str, Any]:
    entry: Dict[str, Any] = {
        "id": _uid("log"),
        "timestamp": _now_iso(),
        "type": tx_type,
        "fromId": from_id,
        "fromName": from_name,
        "toId": to_id,
        "toName": to_name,
        "amount": int(amount),
        "reason": reason,
        "isBankAction": is_bank_action,
    }
    if global_banner:
        entry["globalBanner"] = global_banner
    if property_id:
        entry["propertyId"] = property_id
    if property_name:
        entry["propertyName"] = property_name

    room["auditLog"].append(entry)
    room["version"] = int(room.get("version", 1)) + 1
    return entry


def transfer_funds(
    room: Dict[str, Any],
    actor_id: str,
    from_id: str,
    to_id: str,
    amount: int,
    reason: str = "Trasferimento",
    is_tax_or_fine: bool = False,
) -> Dict[str, Any]:
    """Esegue un pagamento validato lato server (Giocatore->Giocatore, Giocatore->Banca, Banca->Giocatore)."""
    amt = int(amount)
    if amt <= 0:
        raise RuleViolationError("L'importo deve essere maggiore di zero.")
    if from_id == to_id:
        raise RuleViolationError("Mittente e destinatario non possono coincidere.")

    clean_reason = (reason or "Trasferimento").strip()
    cur = room["currency"]

    if from_id == "BANK":
        _require_banker(room, actor_id)
        to_player = _get_player(room, to_id)
        if to_player["isBankrupt"]:
            raise RuleViolationError("Non puoi accreditare fondi a un giocatore in bancarotta.")
        to_player["balance"] += amt
        banner = f"🏦 LA BANCA ha accreditato {amt}{cur} a {to_player['name']} — {clean_reason}"
        return _append_log(
            room,
            tx_type="BANK_CREDIT",
            from_id="BANK",
            from_name="BANCA",
            to_id=to_id,
            to_name=to_player["name"],
            amount=amt,
            reason=clean_reason,
            is_bank_action=True,
            global_banner=banner,
        )

    if to_id == "BANK":
        # Il giocatore paga alla Banca (o il Banchiere addebita una tassa/multa? Per anti-cheat, un giocatore può pagare la Banca, oppure il Banchiere può eseguire un addebito tassa solo se actor è il giocatore o il Banchiere per tasse/multe)
        if actor_id != from_id and actor_id != room["bankerId"]:
            raise RuleViolationError("Non sei autorizzato a eseguire questo pagamento.", code="FORBIDDEN")
        from_player = _get_player(room, from_id)
        _ensure_sufficient_funds(room, from_id, amt, creditor_id="BANK")
        from_player["balance"] -= amt

        pot_note = ""
        if is_tax_or_fine and room.get("freeParkingEnabled"):
            room["freeParkingPot"] = int(room.get("freeParkingPot", 0)) + amt
            pot_note = f" (Salvadanaio Parcheggio: {room['freeParkingPot']}{cur})"

        is_bank_op = actor_id == room["bankerId"]
        banner = (
            f"🏦 {from_player['name']} ha pagato {amt}{cur} alla BANCA — {clean_reason}{pot_note}"
            if is_bank_op or pot_note
            else None
        )
        return _append_log(
            room,
            tx_type="BANK_DEBIT",
            from_id=from_id,
            from_name=from_player["name"],
            to_id="BANK",
            to_name="BANCA",
            amount=amt,
            reason=clean_reason + pot_note,
            is_bank_action=bool(banner),
            global_banner=banner,
        )

    # Giocatore -> Giocatore
    if actor_id != from_id:
        raise RuleViolationError("Puoi inviare pagamenti solo dal tuo conto personale.", code="FORBIDDEN")
    from_player = _get_player(room, from_id)
    to_player = _get_player(room, to_id)
    if to_player["isBankrupt"]:
        raise RuleViolationError("Il destinatario è in bancarotta.")
    _ensure_sufficient_funds(room, from_id, amt, creditor_id=to_id)

    from_player["balance"] -= amt
    to_player["balance"] += amt
    return _append_log(
        room,
        tx_type="PLAYER_TRANSFER",
        from_id=from_id,
        from_name=from_player["name"],
        to_id=to_id,
        to_name=to_player["name"],
        amount=amt,
        reason=clean_reason,
        is_bank_action=False,
    )


def claim_free_parking(room: Dict[str, Any], actor_id: str, to_player_id: str) -> Dict[str, Any]:
    """Assegna il salvadanaio Parcheggio Gratuito a un giocatore (solo Banchiere)."""
    _require_banker(room, actor_id)
    if not room.get("freeParkingEnabled"):
        raise RuleViolationError("Il salvadanaio Parcheggio Gratuito è disattivato.")
    pot = int(room.get("freeParkingPot", 0))
    if pot <= 0:
        raise RuleViolationError("Il salvadanaio Parcheggio Gratuito è vuoto.")
    player = _get_player(room, to_player_id)
    if player["isBankrupt"]:
        raise RuleViolationError("Il giocatore è in bancarotta.")

    player["balance"] += pot
    room["freeParkingPot"] = 0
    return _append_log(
        room,
        tx_type="FREE_PARKING_CLAIM",
        from_id="BANK",
        from_name="PARCHEGGIO GRATUITO",
        to_id=to_player_id,
        to_name=player["name"],
        amount=pot,
        reason="Riscossione Salvadanaio Parcheggio Gratuito",
        is_bank_action=True,
        global_banner=f"🅿️ LA BANCA ha assegnato {pot}{room['currency']} del Parcheggio Gratuito a {player['name']}!",
    )


def buy_property(room: Dict[str, Any], actor_id: str, prop_id: str) -> Dict[str, Any]:
    """Acquisto di una proprietà libera dalla Banca."""
    player = _get_player(room, actor_id)
    prop = _get_property(room, prop_id)
    if prop.get("ownerId") is not None:
        raise RuleViolationError("Questa proprietà appartiene già a un giocatore.")
    price = int(prop["price"])
    _ensure_sufficient_funds(room, actor_id, price, creditor_id="BANK")

    player["balance"] -= price
    prop["ownerId"] = actor_id
    prop["mortgaged"] = False
    prop["houses"] = 0

    return _append_log(
        room,
        tx_type="PROPERTY_BUY",
        from_id=actor_id,
        from_name=player["name"],
        to_id="BANK",
        to_name="BANCA",
        amount=price,
        reason=f"Acquisto contratto: {prop['name']}",
        is_bank_action=True,
        global_banner=f"📜 {player['name']} ha acquistato {prop['name']} per {price}{room['currency']}",
        property_id=prop_id,
        property_name=prop["name"],
    )


def calculate_rent(room: Dict[str, Any], prop_id: str, dice_roll: Optional[int] = None) -> Dict[str, Any]:
    """Calcola automaticamente l'affitto esatto in base alle regole ufficiali del Monopoly."""
    prop = _get_property(room, prop_id)
    owner_id = prop.get("ownerId")
    if not owner_id:
        return {"amount": 0, "blocked": True, "reason": "Proprietà libera (appartiene alla Banca)."}
    if prop.get("mortgaged"):
        return {"amount": 0, "blocked": True, "reason": "Proprietà ipotecata — affitto azzerato."}

    ptype = prop.get("type")
    if ptype == "street":
        houses = int(prop.get("houses", 0))
        rents = prop["rents"]
        if houses == 5:
            return {"amount": int(rents["hotel"]), "blocked": False, "reason": "Affitto con Hotel"}
        if 1 <= houses <= 4:
            return {"amount": int(rents[f"house{houses}"]), "blocked": False, "reason": f"Affitto con {houses} cas{'a' if houses == 1 else 'e'}"}
        if _owns_full_group(room, owner_id, prop["colorGroup"]):
            return {"amount": int(rents["monopoly"]), "blocked": False, "reason": "Serie completa (affitto raddoppiato)"}
        return {"amount": int(rents["base"]), "blocked": False, "reason": "Affitto base"}

    if ptype == "station":
        owned_stations = sum(
            1 for p in room["properties"] if p.get("type") == "station" and p.get("ownerId") == owner_id
        )
        sr = prop["stationRents"]
        amount = int(sr.get(f"s{owned_stations}", sr["s1"]))
        return {
            "amount": amount,
            "blocked": False,
            "reason": f"{owned_stations} stazion{'e' if owned_stations == 1 else 'i'} possedut{'a' if owned_stations == 1 else 'e'}",
        }

    if ptype == "utility":
        if dice_roll is None or not (2 <= int(dice_roll) <= 12):
            raise RuleViolationError("Inserisci il risultato dei due dadi (da 2 a 12) per calcolare l'affitto della Società.")
        owned_utils = sum(
            1 for p in room["properties"] if p.get("type") == "utility" and p.get("ownerId") == owner_id
        )
        mult = int(prop["multipliers"]["u2"] if owned_utils >= 2 else prop["multipliers"]["u1"])
        amount = int(dice_roll) * mult
        return {
            "amount": amount,
            "blocked": False,
            "reason": f"Dadi {dice_roll} × {mult} ({owned_utils} società)",
        }

    raise RuleViolationError("Tipo proprietà non supportato.")


def request_rent(
    room: Dict[str, Any],
    actor_id: str,
    prop_id: str,
    debtor_id: str,
    dice_roll: Optional[int] = None,
) -> Dict[str, Any]:
    """Invia una richiesta di addebito affitto stile Apple Pay al giocatore debitore."""
    prop = _get_property(room, prop_id)
    owner_id = prop.get("ownerId")
    if not owner_id:
        raise RuleViolationError("Questa proprietà non ha un proprietario.")
    if actor_id != owner_id and actor_id != debtor_id:
        raise RuleViolationError("Solo il proprietario o il debitore possono avviare la riscossione.")
    if debtor_id == owner_id:
        raise RuleViolationError("Non puoi pagare l'affitto a te stesso.")

    debtor = _get_player(room, debtor_id)
    if debtor["isBankrupt"]:
        raise RuleViolationError("Il giocatore selezionato è in bancarotta.")

    calc = calculate_rent(room, prop_id, dice_roll)
    if calc["blocked"]:
        raise RuleViolationError(calc["reason"])

    req = {
        "id": _uid("req"),
        "type": "rent_charge",
        "fromPlayerId": debtor_id,
        "toPlayerId": owner_id,
        "propertyId": prop_id,
        "propertyName": prop["name"],
        "amount": calc["amount"],
        "detail": calc["reason"],
        "diceRoll": dice_roll,
        "status": "pending",
        "createdAt": _now_iso(),
    }
    room["pendingRequests"].append(req)
    room["version"] = int(room.get("version", 1)) + 1
    return req


def respond_rent(room: Dict[str, Any], actor_id: str, request_id: str, accept: bool = True) -> Optional[Dict[str, Any]]:
    """Il debitore conferma con un tap il pagamento dell'affitto (o lo rifiuta se inserito per errore)."""
    req = _find_pending_request(room, request_id, "rent_charge")
    if actor_id != req["fromPlayerId"] and actor_id != req["toPlayerId"]:
        raise RuleViolationError("Non autorizzato.", code="FORBIDDEN")

    if not accept:
        room["pendingRequests"] = [r for r in room["pendingRequests"] if r["id"] != request_id]
        room["version"] = int(room.get("version", 1)) + 1
        return None

    if actor_id != req["fromPlayerId"]:
        raise RuleViolationError("Solo il giocatore debitore può confermare il pagamento.", code="FORBIDDEN")

    debtor = _get_player(room, req["fromPlayerId"])
    owner = _get_player(room, req["toPlayerId"])
    amount = int(req["amount"])
    _ensure_sufficient_funds(room, debtor["id"], amount, creditor_id=owner["id"])

    debtor["balance"] -= amount
    owner["balance"] += amount
    room["pendingRequests"] = [r for r in room["pendingRequests"] if r["id"] != request_id]

    return _append_log(
        room,
        tx_type="RENT_PAYMENT",
        from_id=debtor["id"],
        from_name=debtor["name"],
        to_id=owner["id"],
        to_name=owner["name"],
        amount=amount,
        reason=f"Affitto {req['propertyName']} ({req['detail']})",
        is_bank_action=False,
        property_id=req["propertyId"],
        property_name=req["propertyName"],
    )


def validate_build_action(room: Dict[str, Any], player_id: str, prop_id: str, action: str) -> Tuple[Dict[str, Any], int]:
    """Verifica rigorosamente le regole ufficiali di costruzione/demolizione uniforme."""
    prop = _get_property(room, prop_id)
    if prop.get("type") != "street":
        raise RuleViolationError("Puoi costruire case e hotel solo sui terreni edificabili.")
    if prop.get("ownerId") != player_id:
        raise RuleViolationError("Non possiedi questa proprietà.")

    group = _get_group_properties(room, prop["colorGroup"])
    if not _owns_full_group(room, player_id, prop["colorGroup"]):
        raise RuleViolationError("Devi possedere tutte le proprietà di questo gruppo colore per costruire.")
    if _group_has_any_mortgage(room, prop["colorGroup"]):
        raise RuleViolationError("Non puoi costruire o vendere edifici finché una proprietà del gruppo è ipotecata.")

    houses = int(prop.get("houses", 0))
    house_cost = int(prop["houseCost"])

    if action == "build":
        if houses >= 5:
            raise RuleViolationError("Hai già costruito un Hotel su questa proprietà.")
        min_houses = min(int(p.get("houses", 0)) for p in group)
        if houses > min_houses:
            raise RuleViolationError(
                "Regola della costruzione uniforme: costruisci prima sulle altre proprietà dello stesso colore."
            )
        _ensure_sufficient_funds(room, player_id, house_cost, creditor_id="BANK")
        return prop, house_cost

    if action == "sell":
        if houses <= 0:
            raise RuleViolationError("Non ci sono case o hotel da vendere su questa proprietà.")
        max_houses = max(int(p.get("houses", 0)) for p in group)
        if houses < max_houses:
            raise RuleViolationError(
                "Regola della demolizione uniforme: vendi prima gli edifici dalle proprietà del gruppo con più case."
            )
        return prop, house_cost // 2

    raise RuleViolationError("Azione edificio non valida.")


def request_build(room: Dict[str, Any], actor_id: str, prop_id: str, action: str = "build") -> Dict[str, Any]:
    """Invia una richiesta di costruzione/vendita casa/hotel al Banchiere."""
    prop, amount = validate_build_action(room, actor_id, prop_id, action)
    req = {
        "id": _uid("req"),
        "type": "build_request",
        "playerId": actor_id,
        "propertyId": prop_id,
        "propertyName": prop["name"],
        "action": action,
        "amount": amount,
        "currentHouses": int(prop.get("houses", 0)),
        "status": "pending",
        "createdAt": _now_iso(),
    }
    room["pendingRequests"].append(req)
    room["version"] = int(room.get("version", 1)) + 1
    return req


def approve_build(room: Dict[str, Any], actor_id: str, request_id: str, approve: bool = True) -> Optional[Dict[str, Any]]:
    """Il Banchiere approva o rifiuta la costruzione/demolizione."""
    _require_banker(room, actor_id)
    req = _find_pending_request(room, request_id, "build_request")

    if not approve:
        room["pendingRequests"] = [r for r in room["pendingRequests"] if r["id"] != request_id]
        room["version"] = int(room.get("version", 1)) + 1
        return None

    player = _get_player(room, req["playerId"])
    prop, amount = validate_build_action(room, req["playerId"], req["propertyId"], req["action"])
    room["pendingRequests"] = [r for r in room["pendingRequests"] if r["id"] != request_id]

    if req["action"] == "build":
        player["balance"] -= amount
        prop["houses"] = int(prop.get("houses", 0)) + 1
        label = "Hotel" if prop["houses"] == 5 else f"{prop['houses']}ª Casa"
        return _append_log(
            room,
            tx_type="BUILD_HOUSE",
            from_id=player["id"],
            from_name=player["name"],
            to_id="BANK",
            to_name="BANCA",
            amount=amount,
            reason=f"Costruzione {label} su {prop['name']}",
            is_bank_action=True,
            global_banner=f"🏠 LA BANCA ha approvato {label} su {prop['name']} per {player['name']} (-{amount}{room['currency']})",
            property_id=prop["id"],
            property_name=prop["name"],
        )
    else:
        prop["houses"] = int(prop.get("houses", 0)) - 1
        player["balance"] += amount
        return _append_log(
            room,
            tx_type="SELL_HOUSE",
            from_id="BANK",
            from_name="BANCA",
            to_id=player["id"],
            to_name=player["name"],
            amount=amount,
            reason=f"Vendita edificio su {prop['name']}",
            is_bank_action=True,
            global_banner=f"🏚️ LA BANCA ha rimborsato {amount}{room['currency']} a {player['name']} per vendita edificio su {prop['name']}",
            property_id=prop["id"],
            property_name=prop["name"],
        )


def validate_mortgage_action(room: Dict[str, Any], player_id: str, prop_id: str, action: str) -> Tuple[Dict[str, Any], int]:
    """Verifica le regole di ipoteca e disipoteca."""
    prop = _get_property(room, prop_id)
    if prop.get("ownerId") != player_id:
        raise RuleViolationError("Non possiedi questa proprietà.")

    if action == "mortgage":
        if prop.get("mortgaged"):
            raise RuleViolationError("Questa proprietà è già ipotecata.")
        if prop.get("type") == "street" and _group_has_any_houses(room, prop["colorGroup"]):
            raise RuleViolationError("Devi prima vendere tutte le case/hotel del gruppo colore per poter ipotecare.")
        return prop, int(prop["mortgageValue"])

    if action == "unmortgage":
        if not prop.get("mortgaged"):
            raise RuleViolationError("Questa proprietà non è ipotecata.")
        cost = int(prop["unmortgageCost"])
        _ensure_sufficient_funds(room, player_id, cost, creditor_id="BANK")
        return prop, cost

    raise RuleViolationError("Azione ipoteca non valida.")


def request_mortgage(room: Dict[str, Any], actor_id: str, prop_id: str, action: str = "mortgage") -> Dict[str, Any]:
    prop, amount = validate_mortgage_action(room, actor_id, prop_id, action)
    req = {
        "id": _uid("req"),
        "type": "mortgage_request",
        "playerId": actor_id,
        "propertyId": prop_id,
        "propertyName": prop["name"],
        "action": action,
        "amount": amount,
        "status": "pending",
        "createdAt": _now_iso(),
    }
    room["pendingRequests"].append(req)
    room["version"] = int(room.get("version", 1)) + 1
    return req


def approve_mortgage(room: Dict[str, Any], actor_id: str, request_id: str, approve: bool = True) -> Optional[Dict[str, Any]]:
    _require_banker(room, actor_id)
    req = _find_pending_request(room, request_id, "mortgage_request")

    if not approve:
        room["pendingRequests"] = [r for r in room["pendingRequests"] if r["id"] != request_id]
        room["version"] = int(room.get("version", 1)) + 1
        return None

    player = _get_player(room, req["playerId"])
    prop, amount = validate_mortgage_action(room, req["playerId"], req["propertyId"], req["action"])
    room["pendingRequests"] = [r for r in room["pendingRequests"] if r["id"] != request_id]

    if req["action"] == "mortgage":
        prop["mortgaged"] = True
        player["balance"] += amount
        return _append_log(
            room,
            tx_type="MORTGAGE",
            from_id="BANK",
            from_name="BANCA",
            to_id=player["id"],
            to_name=player["name"],
            amount=amount,
            reason=f"Ipoteca su {prop['name']}",
            is_bank_action=True,
            global_banner=f"🔒 LA BANCA ha ipotecato {prop['name']} per {player['name']} (+{amount}{room['currency']})",
            property_id=prop["id"],
            property_name=prop["name"],
        )
    else:
        player["balance"] -= amount
        prop["mortgaged"] = False
        return _append_log(
            room,
            tx_type="UNMORTGAGE",
            from_id=player["id"],
            from_name=player["name"],
            to_id="BANK",
            to_name="BANCA",
            amount=amount,
            reason=f"Disipoteca {prop['name']} (valore + 10%)",
            is_bank_action=True,
            global_banner=f"🔓 LA BANCA ha disipotecato {prop['name']} per {player['name']} (-{amount}{room['currency']})",
            property_id=prop["id"],
            property_name=prop["name"],
        )


def _validate_trade_items(
    room: Dict[str, Any],
    from_id: str,
    to_id: str,
    offer_props: List[str],
    offer_cash: int,
    request_props: List[str],
    request_cash: int,
) -> None:
    if from_id == to_id:
        raise RuleViolationError("Non puoi fare uno scambio con te stesso.")
    if offer_cash < 0 or request_cash < 0:
        raise RuleViolationError("Gli importi in denaro non possono essere negativi.")
    if not offer_props and not request_props and offer_cash == 0 and request_cash == 0:
        raise RuleViolationError("Inserisci almeno una proprietà o un importo nello scambio.")

    _ensure_sufficient_funds(room, from_id, offer_cash, creditor_id=to_id)
    _ensure_sufficient_funds(room, to_id, request_cash, creditor_id=from_id)

    for pid in offer_props:
        prop = _get_property(room, pid)
        if prop.get("ownerId") != from_id:
            raise RuleViolationError(f"Non possiedi {prop['name']}.")
        if prop.get("type") == "street" and _group_has_any_houses(room, prop["colorGroup"]):
            raise RuleViolationError(f"Vendi prima gli edifici del gruppo di {prop['name']} prima di scambiarla.")

    for pid in request_props:
        prop = _get_property(room, pid)
        if prop.get("ownerId") != to_id:
            raise RuleViolationError(f"La controparte non possiede {prop['name']}.")
        if prop.get("type") == "street" and _group_has_any_houses(room, prop["colorGroup"]):
            raise RuleViolationError(f"La controparte deve vendere gli edifici del gruppo di {prop['name']} prima dello scambio.")


def create_trade(
    room: Dict[str, Any],
    actor_id: str,
    to_player_id: str,
    offer_properties: List[str],
    offer_cash: int,
    request_properties: List[str],
    request_cash: int,
) -> Dict[str, Any]:
    """Crea una proposta di scambio/compravendita tra giocatori."""
    _validate_trade_items(room, actor_id, to_player_id, offer_properties, int(offer_cash), request_properties, int(request_cash))
    req = {
        "id": _uid("trd"),
        "type": "trade_offer",
        "fromPlayerId": actor_id,
        "toPlayerId": to_player_id,
        "offerProperties": list(offer_properties),
        "offerCash": int(offer_cash),
        "requestProperties": list(request_properties),
        "requestCash": int(request_cash),
        "acceptedByRecipient": False,
        "approvedByBanker": False,
        "status": "pending_recipient",
        "createdAt": _now_iso(),
    }
    room["pendingRequests"].append(req)
    room["version"] = int(room.get("version", 1)) + 1
    return req


def respond_trade(room: Dict[str, Any], actor_id: str, request_id: str, accept: bool) -> Dict[str, Any]:
    """La controparte accetta o rifiuta lo scambio."""
    req = _find_pending_request(room, request_id, "trade_offer")
    if actor_id != req["toPlayerId"]:
        raise RuleViolationError("Solo il destinatario dello scambio può rispondere.", code="FORBIDDEN")
    if not accept:
        room["pendingRequests"] = [r for r in room["pendingRequests"] if r["id"] != request_id]
        room["version"] = int(room.get("version", 1)) + 1
        return {"status": "rejected"}

    _validate_trade_items(
        room,
        req["fromPlayerId"],
        req["toPlayerId"],
        req["offerProperties"],
        req["offerCash"],
        req["requestProperties"],
        req["requestCash"],
    )
    req["acceptedByRecipient"] = True
    req["status"] = "pending_banker"
    room["version"] = int(room.get("version", 1)) + 1
    return req


def approve_trade(room: Dict[str, Any], actor_id: str, request_id: str, approve: bool) -> Optional[Dict[str, Any]]:
    """Il Banchiere convalida ed esegue lo scambio tra i giocatori."""
    _require_banker(room, actor_id)
    req = _find_pending_request(room, request_id, "trade_offer")
    if req["status"] != "pending_banker":
        raise RuleViolationError("Lo scambio deve prima essere accettato dalla controparte.")

    if not approve:
        room["pendingRequests"] = [r for r in room["pendingRequests"] if r["id"] != request_id]
        room["version"] = int(room.get("version", 1)) + 1
        return None

    _validate_trade_items(
        room,
        req["fromPlayerId"],
        req["toPlayerId"],
        req["offerProperties"],
        req["offerCash"],
        req["requestProperties"],
        req["requestCash"],
    )

    p_from = _get_player(room, req["fromPlayerId"])
    p_to = _get_player(room, req["toPlayerId"])

    p_from["balance"] -= req["offerCash"]
    p_to["balance"] += req["offerCash"]
    p_to["balance"] -= req["requestCash"]
    p_from["balance"] += req["requestCash"]

    offered_names = []
    for pid in req["offerProperties"]:
        prop = _get_property(room, pid)
        prop["ownerId"] = p_to["id"]
        offered_names.append(prop["name"])

    requested_names = []
    for pid in req["requestProperties"]:
        prop = _get_property(room, pid)
        prop["ownerId"] = p_from["id"]
        requested_names.append(prop["name"])

    room["pendingRequests"] = [r for r in room["pendingRequests"] if r["id"] != request_id]

    cur = room["currency"]
    summary_from = ", ".join(offered_names + ([f"{req['offerCash']}{cur}"] if req["offerCash"] else [])) or "nulla"
    summary_to = ", ".join(requested_names + ([f"{req['requestCash']}{cur}"] if req["requestCash"] else [])) or "nulla"

    return _append_log(
        room,
        tx_type="TRADE",
        from_id=p_from["id"],
        from_name=p_from["name"],
        to_id=p_to["id"],
        to_name=p_to["name"],
        amount=max(req["offerCash"], req["requestCash"]),
        reason=f"Scambio convalidato: {p_from['name']} cede [{summary_from}] per [{summary_to}]",
        is_bank_action=True,
        global_banner=f"🤝 SCAMBIO CONVALIDATO: {p_from['name']} ({summary_from}) ⇄ {p_to['name']} ({summary_to})",
    )


def get_debt_suggestions(room: Dict[str, Any], player_id: str, required_amount: int) -> Dict[str, Any]:
    """Calcola suggerimenti intelligenti per coprire un debito (vendita case uniforme + ipoteche)."""
    player = _get_player(room, player_id)
    deficit = max(0, int(required_amount) - int(player["balance"]))
    sell_houses: List[Dict[str, Any]] = []
    mortgage_props: List[Dict[str, Any]] = []

    # Case vendibili rispettando la demolizione uniforme
    owned_streets = [p for p in room["properties"] if p.get("ownerId") == player_id and p.get("type") == "street"]
    groups_checked = set()
    for s in owned_streets:
        cg = s["colorGroup"]
        if cg in groups_checked:
            continue
        groups_checked.add(cg)
        group = _get_group_properties(room, cg)
        if _group_has_any_mortgage(room, cg):
            continue
        max_h = max(int(p.get("houses", 0)) for p in group)
        if max_h > 0:
            for p in group:
                if int(p.get("houses", 0)) == max_h:
                    sell_houses.append(
                        {
                            "propertyId": p["id"],
                            "propertyName": p["name"],
                            "refund": int(p["houseCost"]) // 2,
                            "currentHouses": max_h,
                        }
                    )

    # Proprietà ipotecabili (nessuna casa nel gruppo)
    for p in room["properties"]:
        if p.get("ownerId") == player_id and not p.get("mortgaged"):
            if p.get("type") == "street" and _group_has_any_houses(room, p["colorGroup"]):
                continue
            mortgage_props.append(
                {
                    "propertyId": p["id"],
                    "propertyName": p["name"],
                    "mortgageValue": int(p["mortgageValue"]),
                }
            )

    total_possible = sum(x["refund"] for x in sell_houses) + sum(x["mortgageValue"] for x in mortgage_props)
    return {
        "deficit": deficit,
        "sellHouses": sell_houses,
        "mortgageProperties": mortgage_props,
        "canPotentiallyCover": total_possible >= deficit,
    }


def declare_bankruptcy(room: Dict[str, Any], actor_id: str, creditor_id: str = "BANK") -> Dict[str, Any]:
    """Dichiara bancarotta e trasferisce i beni residui al creditore (o alla Banca)."""
    player = _get_player(room, actor_id)
    if player["isBankrupt"]:
        raise RuleViolationError("Giocatore già in bancarotta.")

    remaining_cash = max(0, int(player["balance"]))
    player["balance"] = 0
    player["isBankrupt"] = True

    # Rimuovi eventuali richieste pendenti del giocatore
    room["pendingRequests"] = [
        r for r in room["pendingRequests"]
        if r.get("fromPlayerId") != actor_id and r.get("playerId") != actor_id
    ]

    creditor_name = "BANCA"
    if creditor_id != "BANK" and creditor_id in room["players"]:
        creditor = room["players"][creditor_id]
        creditor["balance"] += remaining_cash
        creditor_name = creditor["name"]
        for p in room["properties"]:
            if p.get("ownerId") == actor_id:
                p["ownerId"] = creditor_id
    else:
        for p in room["properties"]:
            if p.get("ownerId") == actor_id:
                p["ownerId"] = None
                p["mortgaged"] = False
                p["houses"] = 0

    return _append_log(
        room,
        tx_type="BANKRUPTCY",
        from_id=actor_id,
        from_name=player["name"],
        to_id=creditor_id,
        to_name=creditor_name,
        amount=remaining_cash,
        reason=f"{player['name']} ha dichiarato bancarotta a favore di {creditor_name}",
        is_bank_action=True,
        global_banner=f"🏳️ {player['name']} ha dichiarato BANCAROTTA! Beni trasferiti a {creditor_name}.",
    )


def _find_pending_request(room: Dict[str, Any], request_id: str, expected_type: str) -> Dict[str, Any]:
    for r in room["pendingRequests"]:
        if r["id"] == request_id and r["type"] == expected_type:
            return r
    raise RuleViolationError("Richiesta non trovata o già elaborata.", code="NOT_FOUND")
