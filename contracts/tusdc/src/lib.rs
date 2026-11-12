//! Test USD (Sealed Recipes), symbol tUSDC, 6 decimals: a NEP-141 token with no value, for the Sealed Recipes
//! testnet deployment. Prices, payments, guarantee deposits and payouts there are in tUSDC.
//!
//! Standard NEP-141 (ft_transfer, ft_transfer_call, ft_balance_of, storage management) and NEP-148 metadata, plus:
//! - `mint(account_id, amount)`: only the `minter` (the faucet account) can mint, at most `max_mint` per call, and
//!   only to accounts that asked for it through the faucet. The token is never airdropped to anyone.
//! - The owner can change the minter and the cap.
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey { Token }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    owner: AccountId,
    minter: AccountId,
    max_mint: u128,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, minter: AccountId, max_mint: U128) -> Self {
        Self { token: FungibleToken::new(StorageKey::Token), owner, minter, max_mint: max_mint.0 }
    }

    /// Faucet only: mint test tokens to an account that requested them. Registers the account if needed
    /// (the minter pays its storage from the attached deposit; any excess is refunded by the standard).
    #[payable]
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.minter, "only the minter can mint");
        require!(amount.0 > 0 && amount.0 <= self.max_mint, "amount must be between 1 and max_mint");
        if !self.token.accounts.contains_key(&account_id) {
            let need = self.token.storage_balance_bounds().min;
            require!(env::attached_deposit() >= need, "attach the storage deposit to register a new account");
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        near_contract_standards::fungible_token::events::FtMint { owner_id: &account_id, amount: amount, memo: Some("faucet") }.emit();
    }

    pub fn set_minter(&mut self, minter: AccountId, max_mint: U128) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.minter = minter;
        self.max_mint = max_mint.0;
    }

    pub fn minter(&self) -> (AccountId, U128) { (self.minter.clone(), U128(self.max_mint)) }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) { self.token.ft_transfer(receiver_id, amount, memo) }
    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }
    fn ft_total_supply(&self) -> U128 { self.token.ft_total_supply() }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 { self.token.ft_balance_of(account_id) }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 { near_contract_standards::fungible_token::events::FtBurn { owner_id: &sender_id, amount: U128(burned), memo: None }.emit(); }
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance { self.token.storage_deposit(account_id, registration_only) }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance { self.token.storage_withdraw(amount) }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool { self.token.internal_storage_unregister(force).is_some() }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds { self.token.storage_balance_bounds() }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> { self.token.storage_balance_of(account_id) }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(), name: "Test USD (Sealed Recipes)".to_string(), symbol: "tUSDC".to_string(),
            icon: None, reference: None, reference_hash: None, decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(pred: AccountId, deposit: NearToken) { testing_env!(VMContextBuilder::new().predecessor_account_id(pred).attached_deposit(deposit).build()); }
    fn new() -> Contract { Contract::new(accounts(0), accounts(1), U128(10_000_000_000)) }
    const STORAGE: NearToken = NearToken::from_millinear(13);

    #[test]
    fn faucet_mints_and_registers() {
        ctx(accounts(1), STORAGE);
        let mut c = new();
        c.mint(accounts(2), U128(5_000_000));
        assert_eq!(c.ft_balance_of(accounts(2)).0, 5_000_000);
        assert_eq!(c.ft_total_supply().0, 5_000_000);
        assert_eq!(c.ft_metadata().symbol, "tUSDC");
        assert_eq!(c.ft_metadata().decimals, 6);
    }

    #[test]
    #[should_panic(expected = "only the minter can mint")]
    fn nobody_else_mints() {
        ctx(accounts(3), STORAGE);
        let mut c = new();
        c.mint(accounts(3), U128(1));
    }

    #[test]
    #[should_panic(expected = "amount must be between 1 and max_mint")]
    fn mint_is_capped() {
        ctx(accounts(1), STORAGE);
        let mut c = new();
        c.mint(accounts(2), U128(10_000_000_001));
    }

    #[test]
    #[should_panic(expected = "attach the storage deposit")]
    fn new_accounts_need_storage() {
        ctx(accounts(1), NearToken::from_yoctonear(0));
        let mut c = new();
        c.mint(accounts(2), U128(1));
    }

    #[test]
    fn transfers_between_registered_accounts() {
        ctx(accounts(1), STORAGE);
        let mut c = new();
        c.mint(accounts(2), U128(100));
        c.mint(accounts(3), U128(1));
        ctx(accounts(2), NearToken::from_yoctonear(1));
        c.ft_transfer(accounts(3), U128(40), None);
        assert_eq!(c.ft_balance_of(accounts(2)).0, 60);
        assert_eq!(c.ft_balance_of(accounts(3)).0, 41);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_owner_changes_minter() {
        ctx(accounts(1), NearToken::from_yoctonear(0));
        let mut c = new();
        c.set_minter(accounts(1), U128(1));
    }
}
