"""Test automatici per il motore di gioco Monopoly Pay & Real Estate e API HTTP."""

import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import monopoly_engine as engine
from server import MonopolyHandler


class TestMonopolyEngine(unittest.TestCase):
    def setUp(self):
        self.room, self.banker = engine.create_room_state(
            banker_name="Marco",
            banker_token="cilindro",
            banker_color="#0A84FF",
            currency="€",
            starting_balance=1500,
            free_parking_enabled=True,
        )
        self.p2 = engine.join_room(self.room, "Elena", "cane", "#30D158")

    def test_buy_and_rent_monopoly_doubling(self):
        # Marco compra Vicolo Corto (60) e Vicolo Stretto (60) -> serie marrone completa
        engine.buy_property(self.room, self.banker, "vicolo_corto")
        rent_single = engine.calculate_rent(self.room, "vicolo_corto")
        self.assertEqual(rent_single["amount"], 2)

        engine.buy_property(self.room, self.banker, "vicolo_stretto")
        rent_monopoly = engine.calculate_rent(self.room, "vicolo_corto")
        self.assertEqual(rent_monopoly["amount"], 4)

        # Elena paga affitto tramite richiesta Apple Pay
        req = engine.request_rent(self.room, self.banker, "vicolo_corto", self.p2)
        engine.respond_rent(self.room, self.p2, req["id"], accept=True)
        self.assertEqual(self.room["players"][self.p2]["balance"], 1496)
        self.assertEqual(self.room["players"][self.banker]["balance"], 1500 - 120 + 4)

    def test_uniform_building_and_demolition(self):
        engine.buy_property(self.room, self.banker, "vicolo_corto")
        # Non può costruire senza serie completa
        with self.assertRaises(engine.RuleViolationError):
            engine.request_build(self.room, self.banker, "vicolo_corto", "build")

        engine.buy_property(self.room, self.banker, "vicolo_stretto")
        # Costruisce 1a casa su Vicolo Corto
        r1 = engine.request_build(self.room, self.banker, "vicolo_corto", "build")
        engine.approve_build(self.room, self.banker, r1["id"], True)

        # Non può costruire la 2a casa su Vicolo Corto finché Vicolo Stretto è a 0
        with self.assertRaises(engine.RuleViolationError):
            engine.request_build(self.room, self.banker, "vicolo_corto", "build")

        # Costruisce 1a casa su Vicolo Stretto
        r2 = engine.request_build(self.room, self.banker, "vicolo_stretto", "build")
        engine.approve_build(self.room, self.banker, r2["id"], True)

        # Ora può costruire la 2a su Vicolo Corto
        r3 = engine.request_build(self.room, self.banker, "vicolo_corto", "build")
        engine.approve_build(self.room, self.banker, r3["id"], True)
        self.assertEqual(engine.calculate_rent(self.room, "vicolo_corto")["amount"], 30)

        # Demolizione uniforme: non può vendere da Vicolo Stretto (1 casa) se Corto ha 2 case
        with self.assertRaises(engine.RuleViolationError):
            engine.request_build(self.room, self.banker, "vicolo_stretto", "sell")

    def test_mortgage_blocks_rent_and_houses(self):
        engine.buy_property(self.room, self.banker, "vicolo_corto")
        engine.buy_property(self.room, self.banker, "vicolo_stretto")

        m_req = engine.request_mortgage(self.room, self.banker, "vicolo_corto", "mortgage")
        engine.approve_mortgage(self.room, self.banker, m_req["id"], True)

        rent = engine.calculate_rent(self.room, "vicolo_corto")
        self.assertTrue(rent["blocked"])
        self.assertEqual(rent["amount"], 0)

        # Non può costruire su Vicolo Stretto finché Vicolo Corto è ipotecato
        with self.assertRaises(engine.RuleViolationError):
            engine.request_build(self.room, self.banker, "vicolo_stretto", "build")

        # Disipoteca (+10% -> 33€)
        u_req = engine.request_mortgage(self.room, self.banker, "vicolo_corto", "unmortgage")
        engine.approve_mortgage(self.room, self.banker, u_req["id"], True)
        self.assertFalse(engine._get_property(self.room, "vicolo_corto")["mortgaged"])

    def test_stations_and_utilities(self):
        engine.buy_property(self.room, self.p2, "stazione_nord")
        engine.buy_property(self.room, self.p2, "stazione_sud")
        self.assertEqual(engine.calculate_rent(self.room, "stazione_nord")["amount"], 50)

        engine.buy_property(self.room, self.p2, "societa_elettrica")
        self.assertEqual(engine.calculate_rent(self.room, "societa_elettrica", dice_roll=7)["amount"], 28)
        engine.buy_property(self.room, self.p2, "societa_acqua")
        self.assertEqual(engine.calculate_rent(self.room, "societa_elettrica", dice_roll=7)["amount"], 70)

    def test_trade_and_free_parking_and_insufficient_funds(self):
        engine.buy_property(self.room, self.banker, "vicolo_stretto")
        engine.buy_property(self.room, self.p2, "stazione_nord")

        tr = engine.create_trade(self.room, self.banker, self.p2, ["vicolo_stretto"], 100, ["stazione_nord"], 0)
        engine.respond_trade(self.room, self.p2, tr["id"], True)
        engine.approve_trade(self.room, self.banker, tr["id"], True)

        self.assertEqual(engine._get_property(self.room, "vicolo_stretto")["ownerId"], self.p2)
        self.assertEqual(engine._get_property(self.room, "stazione_nord")["ownerId"], self.banker)

        # Free parking
        engine.transfer_funds(self.room, self.p2, self.p2, "BANK", 200, "Tassa di Lusso", is_tax_or_fine=True)
        self.assertEqual(self.room["freeParkingPot"], 200)
        engine.claim_free_parking(self.room, self.banker, self.banker)
        self.assertEqual(self.room["freeParkingPot"], 0)

        # Fondi insufficienti -> INSUFFICIENT_FUNDS con suggerimenti debito
        with self.assertRaises(engine.RuleViolationError) as ctx:
            engine.transfer_funds(self.room, self.p2, self.p2, self.banker, 99999, "Test")
        self.assertEqual(ctx.exception.code, "INSUFFICIENT_FUNDS")
        self.assertIn("suggestions", ctx.exception.extra)


class TestHttpServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MonopolyHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def _req(self, path, data=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        body = json.dumps(data).encode("utf-8") if data is not None else None
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def test_create_join_and_buy(self):
        st, created = self._req(
            "/api/rooms",
            {"bankerName": "Luca", "token": "auto", "color": "#0A84FF", "currency": "€", "startingBalance": 1500},
        )
        self.assertEqual(st, 201)
        code = created["room"]["code"]
        banker_id = created["playerId"]

        st2, joined = self._req(f"/api/rooms/{code}/join", {"name": "Sara", "token": "nave", "color": "#30D158"})
        self.assertEqual(st2, 200)
        self.assertEqual(len(joined["room"]["players"]), 2)

        st3, bought = self._req(
            f"/api/rooms/{code}/properties/buy",
            {"actorId": banker_id, "propertyId": "parco_della_vittoria"},
        )
        self.assertEqual(st3, 200)
        self.assertEqual(bought["room"]["players"][banker_id]["balance"], 1100)


if __name__ == "__main__":
    unittest.main(verbosity=2)
