import { UNI, USDT } from '../../constants/index'
import {
  Currency,
  CurrencyAmount,
  ETHER,
  JSBI,
  Token,
  TokenAmount,
  borrowableInPeg,
  LeverageType,
  getHoldingAmounts,
  viewCurrentPriceInPeg
} from '@marginswap/sdk'
import { useMemo, useState, useEffect, useCallback } from 'react'
import ERC20_INTERFACE from '../../constants/abis/erc20'
import { useAllTokens } from '../../hooks/Tokens'
import { useActiveWeb3React } from '../../hooks'
import { useMulticallContract } from '../../hooks/useContract'
import { isAddress } from '../../utils'
import { useSingleContractMultipleData, useMultipleContractSingleData } from '../multicall/hooks'
import { useUserUnclaimedAmount } from '../claim/hooks'
import { useTotalUniEarned } from '../stake/hooks'
import { useSwapState } from '../swap/hooks'
import { getProviderOrSigner } from '../../utils'
import usePrevious from '../../hooks/usePrevious'
import { wrappedCurrency } from 'utils/wrappedCurrency'

/**
 * Returns a map of the given addresses to their eventually consistent ETH balances.
 */
export function useETHBalances(
  uncheckedAddresses?: (string | undefined)[]
): { [address: string]: CurrencyAmount | undefined } {
  const multicallContract = useMulticallContract()

  const addresses: string[] = useMemo(
    () =>
      uncheckedAddresses
        ? uncheckedAddresses
            .map(isAddress)
            .filter((a): a is string => a !== false)
            .sort()
        : [],
    [uncheckedAddresses]
  )

  const results = useSingleContractMultipleData(
    multicallContract,
    'getEthBalance',
    addresses.map(address => [address])
  )

  return useMemo(
    () =>
      addresses.reduce<{ [address: string]: CurrencyAmount }>((memo, address, i) => {
        const value = results?.[i]?.result?.[0]
        if (value) memo[address] = CurrencyAmount.ether(JSBI.BigInt(value.toString()))
        return memo
      }, {}),
    [addresses, results]
  )
}

export function useBorrowable(address: string | undefined, currency: Currency | undefined): CurrencyAmount | undefined {
  const { library, chainId } = useActiveWeb3React()
  const provider: any = getProviderOrSigner(library!, address)

  const [balance, setBalance] = useState<CurrencyAmount | undefined>(undefined)
  const updateBorrowableBalance = useCallback(async () => {
    if (address && currency && chainId) {
      const bip = await borrowableInPeg(address, Number(process.env.REACT_APP_CHAIN_ID), provider)

      const borrowable = new TokenAmount(USDT, bip)

      const wrapped = wrappedCurrency(currency, chainId)

      if (wrapped) {
        const hundred = `100${'0'.repeat(wrapped.decimals)}`
        const curPrice = await viewCurrentPriceInPeg(wrapped.address, hundred, chainId, provider)
        if (curPrice.gt(0)) {
          const borrowableValue = borrowable.multiply(hundred).divide(curPrice.toString())

          const result =
            currency.name == 'Ether'
              ? CurrencyAmount.ether(borrowableValue.remainder.toFixed(0))
              : new TokenAmount(wrapped, borrowableValue.remainder.toFixed(0))

          setBalance(result)
        } else {
          setBalance(undefined)
        }
      } else {
        setBalance(undefined)
      }
    }
  }, [address, currency, setBalance])

  useEffect(() => {
    updateBorrowableBalance()
  }, [address, currency, updateBorrowableBalance])
  return balance
}

export function useMarginBalance({ address, validatedTokens }: any) {
  const [balances, setBalances] = useState({})
  const { library } = useActiveWeb3React()
  const previousValidatedTokens = usePrevious(validatedTokens)
  const provider = getProviderOrSigner(library!, address)

  const updateMarginBalances = useCallback(async () => {
    if (address && validatedTokens.length > 0) {
      const memo: { [tokenAddress: string]: TokenAmount } = {}
      const holdingAmounts = await getHoldingAmounts(address, Number(process.env.REACT_APP_CHAIN_ID), provider as any)
      validatedTokens.forEach((token: Token) => {
        const balanceValue = JSBI.BigInt(holdingAmounts[token.address] ?? 0)

        memo[token.address] = new TokenAmount(token, balanceValue)
      })
      setBalances(memo)
    }
  }, [address, validatedTokens, balances, setBalances])

  useEffect(() => {
    if (JSON.stringify(validatedTokens) !== JSON.stringify(previousValidatedTokens)) {
      updateMarginBalances()
    }
  }, [address, library, validatedTokens, balances, setBalances, updateMarginBalances])
  return balances
}

/**
 * Returns a map of token addresses to their eventually consistent token balances for a single account.
 */
export function useTokenBalancesWithLoadingIndicator(
  address?: string,
  tokens?: (Token | undefined)[]
): [{ [tokenAddress: string]: TokenAmount | undefined }, boolean] {
  const validatedTokens: Token[] = useMemo(
    () => tokens?.filter((t?: Token): t is Token => isAddress(t?.address) !== false) ?? [],
    [tokens]
  )
  const validatedTokenAddresses = useMemo(() => validatedTokens.map(vt => vt.address), [validatedTokens])
  const balances = useMultipleContractSingleData(validatedTokenAddresses, ERC20_INTERFACE, 'balanceOf', [address])
  const anyLoading: boolean = useMemo(() => balances.some(callState => callState.loading), [balances])
  const marginBalances = useMarginBalance({ address, validatedTokens })
  const { leverageType } = useSwapState()

  return [
    useMemo(
      () =>
        address && validatedTokens.length > 0
          ? leverageType === LeverageType.CROSS_MARGIN
            ? marginBalances
            : validatedTokens.reduce<{ [tokenAddress: string]: TokenAmount | undefined }>((memo, token, i) => {
                const value = balances?.[i]?.result?.[0]
                const amount = value ? JSBI.BigInt(value.toString()) : undefined
                if (amount) {
                  memo[token.address] = new TokenAmount(token, amount)
                }
                return memo
              }, {})
          : {},
      [address, validatedTokens, balances, marginBalances, leverageType]
    ),
    anyLoading
  ]
}

export function useTokenBalances(
  address?: string,
  tokens?: (Token | undefined)[]
): { [tokenAddress: string]: TokenAmount | undefined } {
  return useTokenBalancesWithLoadingIndicator(address, tokens)[0]
}

// get the balance for a single token/account combo
export function useTokenBalance(account?: string, token?: Token): TokenAmount | undefined {
  const tokenBalances = useTokenBalances(account, [token])
  if (!token) return undefined
  return tokenBalances[token.address]
}

export function useCurrencyBalances(
  account?: string,
  currencies?: (Currency | undefined)[]
): (CurrencyAmount | undefined)[] {
  const tokens = useMemo(() => currencies?.filter((currency): currency is Token => currency instanceof Token) ?? [], [
    currencies
  ])

  const tokenBalances = useTokenBalances(account, tokens)
  const containsETH: boolean = useMemo(() => currencies?.some(currency => currency === ETHER) ?? false, [currencies])
  const ethBalance = useETHBalances(containsETH ? [account] : [])

  return useMemo(
    () =>
      currencies?.map(currency => {
        if (!account || !currency) return undefined
        if (currency instanceof Token) return tokenBalances[currency.address]
        if (currency === ETHER) return ethBalance[account]
        return undefined
      }) ?? [],
    [account, currencies, ethBalance, tokenBalances]
  )
}

export function useCurrencyBalance(account?: string, currency?: Currency): CurrencyAmount | undefined {
  return useCurrencyBalances(account, [currency])[0]
}

// mimics useAllBalances
export function useAllTokenBalances(): { [tokenAddress: string]: TokenAmount | undefined } {
  const { account } = useActiveWeb3React()
  const allTokens = useAllTokens()
  const allTokensArray = useMemo(() => Object.values(allTokens ?? {}), [allTokens])
  const balances = useTokenBalances(account ?? undefined, allTokensArray)
  return balances ?? {}
}

// get the total owned, unclaimed, and unharvested UNI for account
export function useAggregateUniBalance(): TokenAmount | undefined {
  const { account, chainId } = useActiveWeb3React()

  const uni = chainId ? UNI[chainId] : undefined

  const uniBalance: TokenAmount | undefined = useTokenBalance(account ?? undefined, uni)
  const uniUnclaimed: TokenAmount | undefined = useUserUnclaimedAmount(account)
  const uniUnHarvested: TokenAmount | undefined = useTotalUniEarned()

  if (!uni) return undefined

  return new TokenAmount(
    uni,
    JSBI.add(
      JSBI.add(uniBalance?.raw ?? JSBI.BigInt(0), uniUnclaimed?.raw ?? JSBI.BigInt(0)),
      uniUnHarvested?.raw ?? JSBI.BigInt(0)
    )
  )
}
